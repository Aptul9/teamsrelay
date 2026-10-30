import crypto from "node:crypto";
import type { BrowserContext, Page } from "playwright-core";
import { REACTION_EMOJI, type Reaction, type ReadBy } from "@/shared/slot-db/rows";
import { extraOf } from "../logic/messages";
import { errorText, log } from "../log";
import type { SavedMessage } from "../store/slot-store";

export type TeamsAuth = {
  token: string;
  region: string;
  oid?: string;
  upn?: string;
  name?: string;
};

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
const AMS_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SkypeSpaces/1410/0.0.0.0";
const SERVER = "https://teams.microsoft.com";

function parseJwtClaims(token: string): { oid?: string; upn?: string; unique_name?: string; name?: string } {
  try {
    const part = token.split(".")[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
      oid?: string;
      upn?: string;
      unique_name?: string;
      name?: string;
    };
  } catch {
    return {};
  }
}

const authCache = new WeakMap<object, { auth: TeamsAuth; expiresAt: number }>();

// Extract IC3 token and region from BrowserContext cookies OR page localStorage (MSAL v2 on teams.cloud.microsoft)
export async function getTeamsAuth(context: BrowserContext | null | undefined, page?: Page): Promise<TeamsAuth | null> {
  try {
    if (!context || typeof context.cookies !== "function") return null;

    const cacheKey = (page ?? context) as object;
    const cached = authCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.auth;

    const cookies = await context.cookies();

    // Region: from authtoken or McasPartialCookie*authtoken path (e.g. /api/mt/part/emea-03/...) or default "emea"
    let region = "emea";
    const authCookie = cookies.find(
      (c) => (c.name === "authtoken" || c.name.endsWith("authtoken")) && (c.domain.includes("teams.microsoft.com") || c.domain.includes("teams.cloud.microsoft")),
    );
    if (authCookie?.path) {
      const parts = authCookie.path.split("/").filter(Boolean);
      const mtIdx = parts.indexOf("mt");
      if (mtIdx !== -1 && mtIdx + 1 < parts.length) {
        let r = parts[mtIdx + 1];
        if (r === "part" && mtIdx + 2 < parts.length) r = parts[mtIdx + 2];
        region = r.split("-")[0] || "emea";
      }
    }

    // 1. Check cookies for authtoken_asm (WebView2 / MCAS proxy)
    const asm =
      cookies.find(
        (c) =>
          c.name === "authtoken_asm" &&
          (c.domain.includes("asyncgw.teams.microsoft.com") || c.domain.includes("teams.microsoft.com") || c.domain.includes("teams.cloud.microsoft")),
      ) ?? cookies.find((c) => c.name === "authtoken_asm");

    let token = "";
    if (asm?.value) {
      token = asm.value;
      if (token.toLowerCase().startsWith("bearer%20")) token = token.slice(9);
      else if (token.toLowerCase().startsWith("bearer ")) token = token.slice(7);
      else if (token.toLowerCase().startsWith("bearer=")) token = token.slice(7);
      token = decodeURIComponent(token);
    }

    // 2. Check page localStorage for MSAL v2 ic3.teams.office.com access token (standard Teams Web on teams.cloud.microsoft)
    if (!token) {
      const targetPage = page ?? (typeof context.pages === "function" ? context.pages()[0] : undefined);
      if (targetPage && typeof targetPage.evaluate === "function") {
        try {
          const lsToken = await targetPage.evaluate(() => {
            if (typeof localStorage === "undefined") return null;
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i) || "";
              const low = k.toLowerCase();
              if (low.includes("accesstoken") && low.includes("ic3.teams.office.com")) {
                try {
                  const v = JSON.parse(localStorage.getItem(k) || "{}") as { secret?: string };
                  if (typeof v?.secret === "string" && v.secret.length > 50) return v.secret;
                } catch {
                  // ignore
                }
              }
            }
            return null;
          });
          if (lsToken) token = lsToken;
        } catch {
          // page.evaluate might fail in mocks or during navigation
        }
      }
    }

    if (!token) return null;

    const claims = parseJwtClaims(token);
    const auth: TeamsAuth = {
      token,
      region,
      oid: claims.oid,
      upn: claims.upn || claims.unique_name,
      name: claims.name,
    };
    authCache.set(cacheKey, { auth, expiresAt: Date.now() + 60_000 });
    return auth;
  } catch (e) {
    log.warn("chatsvc", `getTeamsAuth failed: ${errorText(e)}`);
    return null;
  }
}

// Extract conversation ID from the open page URL
export async function getOpenConversationId(page: Page): Promise<string | null> {
  try {
    const fromUrl = (url: string) => {
      const m = url.match(/conversations\/([^?&#]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    };
    const direct = fromUrl(page.url());
    if (direct) return direct;
    return await page.evaluate(() => {
      const m = window.location.href.match(/conversations\/([^?&#]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    });
  } catch {
    return null;
  }
}

// Cache of chat name (lowercase) -> conversation ID, and message ID -> conversation ID
const convCache = new Map<string, { id: string; expiresAt: number }>();
const midConvCache = new Map<string, string>();
const lastMsgByConv = new Map<string, { id: string; cmid: string }>();
let lastIdbSyncAt = 0;

function cacheTitle(title: string | undefined | null, id: string, ttlMs = 15 * 60_000) {
  const clean = (title || "").trim();
  if (!clean || !id) return;
  const exp = Date.now() + ttlMs;
  convCache.set(clean, { id, expiresAt: exp });
  convCache.set(clean.toLowerCase(), { id, expiresAt: exp });
}

// Read conversation title->id and mid->convId mappings directly from Teams Web IndexedDB in the browser
export async function syncIndexedDbMappings(page: Page, force = false): Promise<void> {
  if (!force && Date.now() - lastIdbSyncAt < 20_000) return;
  lastIdbSyncAt = Date.now();
  try {
    const res = await page.evaluate(async () => {
      if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return null;
      const dbs = await indexedDB.databases();
      const convs: { id: string; titles: string[] }[] = [];
      const mids: { mid: string; cid: string }[] = [];

      for (const info of dbs) {
        const dbName = info.name || "";
        if (!dbName.includes(":conversation-manager:") && !dbName.includes(":replychain-manager:")) continue;
        try {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(dbName);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          if (dbName.includes(":conversation-manager:") && db.objectStoreNames.contains("conversations")) {
            const rows = await new Promise<Array<Record<string, unknown>>>((resolve) => {
              const tx = db.transaction("conversations", "readonly");
              const req = tx.objectStore("conversations").getAll();
              req.onsuccess = () => resolve((req.result as Array<Record<string, unknown>>) || []);
              req.onerror = () => resolve([]);
            });
            for (const r of rows) {
              const id = typeof r?.id === "string" ? r.id : "";
              if (!id) continue;
              const titles: string[] = [];
              const tp = (r.threadProperties || {}) as Record<string, unknown>;
              const ct = (r.chatTitle || {}) as Record<string, unknown>;
              for (const k of ["topic", "spaceThreadTopic", "topicThreadTopic"]) {
                if (typeof tp[k] === "string" && (tp[k] as string).trim()) titles.push((tp[k] as string).trim());
              }
              for (const k of ["shortTitle", "longTitle"]) {
                if (typeof ct[k] === "string" && (ct[k] as string).trim()) titles.push((ct[k] as string).trim());
              }
              const users = Array.isArray(ct.avatarUsersInfo) ? (ct.avatarUsersInfo as Array<Record<string, unknown>>) : [];
              if (users.length === 1 && typeof users[0]?.displayName === "string") {
                const dn = (users[0].displayName as string).trim();
                if (dn) {
                  titles.push(dn);
                  if (id === "48:notes") titles.push(`${dn} (You)`);
                }
              }
              if (titles.length) convs.push({ id, titles });
            }
          }
          if (dbName.includes(":replychain-manager:") && db.objectStoreNames.contains("replychains-2")) {
            const rows = await new Promise<Array<Record<string, unknown>>>((resolve) => {
              const tx = db.transaction("replychains-2", "readonly");
              const req = tx.objectStore("replychains-2").getAll();
              req.onsuccess = () => resolve((req.result as Array<Record<string, unknown>>) || []);
              req.onerror = () => resolve([]);
            });
            for (const rc of rows) {
              const map = (rc?.messageMap || {}) as Record<string, Record<string, unknown>>;
              for (const m of Object.values(map)) {
                const mid = typeof m?.id === "string" ? m.id : typeof m?.dedupeKey === "string" ? m.dedupeKey : "";
                const cid = typeof m?.conversationId === "string" ? m.conversationId : "";
                if (mid && cid) mids.push({ mid, cid });
              }
            }
          }
          db.close();
        } catch {
          // ignore individual DB errors
        }
      }
      return { convs, mids };
    });

    if (res && typeof res === "object") {
      for (const c of res.convs ?? []) {
        for (const t of c.titles) cacheTitle(t, c.id);
      }
      for (const m of res.mids ?? []) {
        midConvCache.set(m.mid, m.cid);
      }
    }
  } catch {
    // page.evaluate may not support indexedDB in unit test mocks
  }
}

export async function resolveConversationId(auth: TeamsAuth, page: Page, chat: string, mid?: string): Promise<string | null> {
  // 1. Direct ID or self-chat
  if (chat.startsWith("19:") || chat.startsWith("48:")) return chat;
  if (/\(You\)$/i.test(chat.trim())) return "48:notes";

  // 2. Known mid -> convId
  if (mid && midConvCache.has(mid)) {
    const cid = midConvCache.get(mid)!;
    cacheTitle(chat, cid);
    return cid;
  }

  // 3. Cache lookup (case-insensitive)
  const hit = convCache.get(chat) ?? convCache.get(chat.trim().toLowerCase());
  if (hit && Date.now() < hit.expiresAt) return hit.id;

  // 4. Sync IndexedDB mappings from the browser
  await syncIndexedDbMappings(page);
  if (mid && midConvCache.has(mid)) {
    const cid = midConvCache.get(mid)!;
    cacheTitle(chat, cid);
    return cid;
  }
  const hitAfterIdb = convCache.get(chat) ?? convCache.get(chat.trim().toLowerCase());
  if (hitAfterIdb && Date.now() < hitAfterIdb.expiresAt) return hitAfterIdb.id;

  // 5. Force re-sync IndexedDB once if not found (in case a new chat just appeared)
  await syncIndexedDbMappings(page, true);
  const hitForceIdb = convCache.get(chat) ?? convCache.get(chat.trim().toLowerCase());
  if (hitForceIdb && Date.now() < hitForceIdb.expiresAt) return hitForceIdb.id;

  // 6. Active open conversation in page URL
  const openId = await getOpenConversationId(page);
  if (openId) {
    cacheTitle(chat, openId);
    return openId;
  }

  // 7. API directory lookup (matches group/meeting topics + 1:1 lastMessage sender names)
  try {
    const url = `${SERVER}/api/chatsvc/${auth.region}/v1/users/ME/conversations?view=msnp24Equivalent&pageSize=200&startTime=0`;
    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        Origin: SERVER,
        Referer: `${SERVER}/v2/`,
        Authorization: `Bearer ${auth.token}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const data = (await resp.json()) as {
        conversations?: Array<{
          id?: string;
          threadProperties?: { topic?: string; spaceThreadTopic?: string; threadTopic?: string };
          lastMessage?: { imdisplayname?: string; fromDisplayNameInToken?: string; from?: string };
        }>;
      };
      const wantLow = chat.trim().toLowerCase();
      let matched: string | null = null;
      for (const c of data.conversations ?? []) {
        if (!c.id) continue;
        const tp = c.threadProperties ?? {};
        const title = tp.topic || tp.spaceThreadTopic || tp.threadTopic;
        if (title) {
          cacheTitle(title, c.id);
          if (title.trim().toLowerCase() === wantLow) matched ??= c.id;
        } else if (c.id.includes("@unq.gbl.spaces") && c.lastMessage) {
          const sender = (c.lastMessage.imdisplayname || c.lastMessage.fromDisplayNameInToken || "").trim();
          const from = c.lastMessage.from || "";
          const isMe = Boolean(auth.oid && from.toLowerCase().includes(auth.oid.toLowerCase()));
          if (sender && !isMe) {
            cacheTitle(sender, c.id);
            if (sender.toLowerCase() === wantLow) matched ??= c.id;
          }
        }
      }
      if (matched) return matched;
    }
  } catch (e) {
    log.warn("chatsvc", `resolveConversationId failed: ${errorText(e)}`, { chat });
  }

  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function toParagraphs(text: string): string {
  const lines = text.split("\n");
  return lines.map((line) => `<p>${line.trim() ? escapeHtml(line) : "&nbsp;"}</p>`).join("");
}

function clientMessageId(): string {
  return `${Date.now()}${crypto.randomInt(100, 999)}`;
}

// Optimistic cache of recently sent/edited/deleted messages so immediate reads see them with zero eventual-consistency lag
type OptimisticPatch = {
  added: Map<string, { msg: SavedMessage; expiresAt: number }>;
  edited: Map<string, { text: string; html: string; expiresAt: number }>;
  deleted: Map<string, number>;
};
const optimisticByConv = new Map<string, OptimisticPatch>();

function getOptimistic(convId: string): OptimisticPatch {
  let p = optimisticByConv.get(convId);
  if (!p) {
    p = { added: new Map(), edited: new Map(), deleted: new Map() };
    optimisticByConv.set(convId, p);
  }
  return p;
}

// Convert raw Teams message HTML into { quote, text, html, images } matching readMessages DOM output
export function parseTeamsMessageHtml(
  rawContent: string,
  myName?: string,
): {
  quote?: { author: string; text: string };
  text: string;
  html: string;
  images: { url: string; w: number; h: number }[];
  mentionsMe: boolean;
} {
  let content = rawContent || "";
  let quote: { author: string; text: string } | undefined;

  const quoteMatch = content.match(/<blockquote[^>]*schema\.skype\.com\/Reply[^>]*>([\s\S]*?)<\/blockquote>/i);
  if (quoteMatch) {
    const inner = quoteMatch[1] || "";
    const whoMatch = inner.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
    const prevMatch = inner.match(/<p[^>]*itemprop=["']preview["'][^>]*>([\s\S]*?)<\/p>/i);
    const author = unescapeHtml((whoMatch?.[1] || "").replace(/<[^>]+>/g, "")).trim().slice(0, 60);
    const qText = unescapeHtml((prevMatch?.[1] || "").replace(/<[^>]+>/g, "")).trim().slice(0, 300);
    if (author || qText) quote = { author, text: qText };
    content = content.replace(quoteMatch[0], "");
  }

  const images: { url: string; w: number; h: number }[] = [];
  let mentionsMe = false;

  // Replace emoji <img> with their alt character, collect non-emoji images
  const withEmojis = content.replace(/<img\b[^>]*>/gi, (tag) => {
    const altMatch = tag.match(/\balt=["']([^"']*)["']/i);
    const alt = altMatch ? unescapeHtml(altMatch[1] || "") : "";
    if (/schema\.skype\.com\/Emoji/i.test(tag) || /emoticon/i.test(tag)) {
      return alt;
    }
    const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i);
    const src = srcMatch ? unescapeHtml(srcMatch[1] || "") : "";
    if (src && !/avatar/i.test(tag)) {
      const wMatch = tag.match(/\bwidth=["'](\d+(?:\.\d+)?)["']/i);
      const hMatch = tag.match(/\bheight=["'](\d+(?:\.\d+)?)["']/i);
      images.push({
        url: src,
        w: wMatch ? Math.round(Number(wMatch[1])) : 0,
        h: hMatch ? Math.round(Number(hMatch[1])) : 0,
      });
    }
    return "";
  });

  // Format mentions
  const withMentions = withEmojis.replace(/<span\b[^>]*schema\.skype\.com\/Mention[^>]*>([\s\S]*?)<\/span>/gi, (_full, innerText: string) => {
    const clean = unescapeHtml(innerText.replace(/<[^>]+>/g, "")).trim();
    const isMe = Boolean(myName && clean.toLowerCase() === myName.toLowerCase());
    if (isMe) mentionsMe = true;
    return `<span class="mn${isMe ? " me" : ""}">${escapeHtml(clean)}</span>`;
  });

  // Plain text extraction
  const textRaw = withEmojis
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|pre|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  const text = unescapeHtml(textRaw)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 2000);

  // Clean HTML keeping safe tags
  const html = withMentions
    .replace(/^(\s|<div>|<p>[\s\u00a0&nbsp;]*<\/p>)+/i, "")
    .replace(/(<p>[\s\u00a0&nbsp;]*<\/p>|\s)+$/i, "")
    .trim()
    .slice(0, 20000);

  return { quote, text, html, images, mentionsMe };
}

type RawTeamsMessage = {
  id?: string;
  clientmessageid?: string;
  messagetype?: string;
  content?: string;
  imdisplayname?: string;
  fromDisplayNameInToken?: string;
  from?: string;
  originalarrivaltime?: string;
  composetime?: string;
  properties?: {
    edittime?: number | string;
    deletetime?: number | string;
    files?: string;
    subject?: string;
    emotions?: Array<{ key?: string; users?: Array<{ mri?: string }> }> | string;
  };
};

// Fetch the recent messages of a conversation via chatsvc API and convert them to SavedMessage[]
export async function fetchChatMessages(
  auth: TeamsAuth,
  convId: string,
  readByCache?: (mids: readonly string[]) => Map<string, ReadBy>,
): Promise<SavedMessage[] | null> {
  try {
    const url = `${SERVER}/api/chatsvc/${auth.region}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages?view=msnp24Equivalent&pageSize=50`;
    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        Origin: SERVER,
        Referer: `${SERVER}/v2/`,
        Authorization: `Bearer ${auth.token}`,
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { messages?: RawTeamsMessage[] };
    const rawList = (data.messages ?? []).filter((m) => {
      const mt = String(m.messagetype || "");
      return !mt.startsWith("ThreadActivity") && mt !== "RichText/Media_CallTranscript";
    });

    // Sort oldest to newest, take last 40
    rawList.sort((a, b) => {
      const ta = Number(a.id) || Date.parse(a.originalarrivaltime || a.composetime || "") || 0;
      const tb = Number(b.id) || Date.parse(b.originalarrivaltime || b.composetime || "") || 0;
      return ta - tb;
    });
    const recent = rawList.slice(-40);
    const lastRaw = recent.at(-1);
    if (lastRaw?.id) {
      lastMsgByConv.set(convId, { id: String(lastRaw.id), cmid: String(lastRaw.clientmessageid || lastRaw.id) });
    }

    const myMids: string[] = [];
    for (const m of recent) {
      const mid = String(m.id || m.clientmessageid || "");
      if (mid) midConvCache.set(mid, convId);
      const mine = convId === "48:notes" || Boolean(auth.oid && String(m.from || "").toLowerCase().includes(auth.oid.toLowerCase()));
      if (mine && mid) myMids.push(mid);
    }
    const readBy = readByCache ? readByCache(myMids) : new Map<string, ReadBy>();
    const opt = getOptimistic(convId);
    const now = Date.now();

    const out: SavedMessage[] = [];
    for (const m of recent) {
      const mid = String(m.id || m.clientmessageid || "");
      const mine = convId === "48:notes" || Boolean(auth.oid && String(m.from || "").toLowerCase().includes(auth.oid.toLowerCase()));
      const author = mine ? "" : String(m.imdisplayname || m.fromDisplayNameInToken || "").trim().slice(0, 60);
      const props = m.properties ?? {};
      const optDel = opt.deleted.get(mid);
      const deleted = Boolean(props.deletetime) || Boolean(optDel && now < optDel);
      const optEdit = opt.edited.get(mid);
      const edited = Boolean(props.edittime) || Boolean(optEdit && now < optEdit.expiresAt);

      const parsed = deleted
        ? { quote: undefined, text: "", html: "", images: [], mentionsMe: false }
        : optEdit && now < optEdit.expiresAt
          ? { quote: undefined, text: optEdit.text, html: optEdit.html, images: [], mentionsMe: false }
          : parseTeamsMessageHtml(m.content || "", auth.name);

      // Parse files
      const files: { name: string; url: string }[] = [];
      if (!deleted && typeof props.files === "string" && props.files.startsWith("[")) {
        try {
          const parsedFiles = JSON.parse(props.files) as Array<Record<string, unknown>>;
          for (const f of parsedFiles) {
            const name = String(f.fileName || f.title || "").trim().slice(0, 160);
            const info = (f.fileInfo || {}) as Record<string, unknown>;
            const fileUrl = String(f.objectUrl || info.shareUrl || info.siteUrl || "").trim();
            if (name && !files.some((x) => x.url === fileUrl)) files.push({ name, url: fileUrl });
          }
        } catch {
          // ignore malformed files JSON
        }
      }

      // Parse reactions
      const reactions: Reaction[] = [];
      const rawEmotions = typeof props.emotions === "string" ? (() => { try { return JSON.parse(props.emotions); } catch { return []; } })() : props.emotions;
      if (Array.isArray(rawEmotions)) {
        for (const em of rawEmotions) {
          const key = String(em?.key || "").toLowerCase();
          const emoji = REACTION_EMOJI[key === "sad" ? "cry" : key];
          const users = Array.isArray(em?.users) ? em.users : [];
          if (emoji && users.length > 0) {
            const isMine = Boolean(auth.oid && users.some((u: { mri?: string }) => String(u?.mri || "").toLowerCase().includes(auth.oid!.toLowerCase())));
            reactions.push({ e: emoji, n: users.length, mine: isMine });
          }
        }
      }
      const reacts = reactions.map((r) => r.e + (r.n > 1 ? r.n : "")).join(" ");

      const extra = extraOf({
        quote: parsed.quote,
        images: parsed.images,
        files,
        reactions,
        status: mine ? "Sent" : "",
        edited,
        readby: readBy.get(mid),
        html: parsed.html,
        mentionsMe: parsed.mentionsMe,
        deleted,
      });

      out.push({
        mid,
        author,
        text: parsed.text,
        mine,
        reacts,
        extra,
      });
    }

    // Append any newly sent optimistic messages not yet returned by the server
    for (const [mid, item] of opt.added) {
      if (now >= item.expiresAt) {
        opt.added.delete(mid);
        continue;
      }
      if (!out.some((x) => x.mid === mid)) {
        out.push(item.msg);
      }
    }

    return out;
  } catch (e) {
    log.warn("chatsvc", `fetchChatMessages failed: ${errorText(e)}`, { convId });
    return null;
  }
}

export async function sendTextMessage(auth: TeamsAuth, convId: string, text: string): Promise<{ ok: boolean; id?: string }> {
  const url = `${SERVER}/api/chatsvc/${auth.region}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages`;
  const htmlBody = toParagraphs(text);
  const body = JSON.stringify({
    content: htmlBody,
    messagetype: "RichText/Html",
    contenttype: "Text",
    clientmessageid: clientMessageId(),
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Origin: SERVER,
      Referer: `${SERVER}/v2/`,
      Authorization: `Bearer ${auth.token}`,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    log.warn("chatsvc", `sendTextMessage HTTP ${resp.status}`, { error: errText.slice(0, 200), convId });
    return { ok: false };
  }

  const json = (await resp.json().catch(() => ({}))) as { OriginalArrivalTime?: number };
  const id = json.OriginalArrivalTime ? String(json.OriginalArrivalTime) : String(Date.now());
  midConvCache.set(id, convId);
  getOptimistic(convId).added.set(id, {
    msg: {
      mid: id,
      author: "",
      text,
      mine: true,
      reacts: "",
      extra: extraOf({ status: "Sent", html: htmlBody }),
    },
    expiresAt: Date.now() + 8_000,
  });
  return { ok: true, id };
}

export async function getMessage(auth: TeamsAuth, convId: string, mid: string): Promise<{ author: string; preview: string; mri: string } | null> {
  try {
    const url = `${SERVER}/api/chatsvc/${auth.region}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages/${mid}`;
    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        Origin: SERVER,
        Referer: `${SERVER}/v2/`,
        Authorization: `Bearer ${auth.token}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const m = (await resp.json()) as { imdisplayname?: string; fromDisplayNameInToken?: string; from?: string; content?: string };
    const author = m.imdisplayname || m.fromDisplayNameInToken || "?";
    const fromUrl = m.from || "";
    const mri = fromUrl.includes("/contacts/") ? fromUrl.split("/contacts/").pop() || "" : "";
    const rawPreview = (m.content || "").replace(/<[^>]+>/g, "").trim().slice(0, 150);
    return { author, preview: rawPreview, mri };
  } catch {
    return null;
  }
}

export async function replyTextMessage(auth: TeamsAuth, convId: string, mid: string, text: string): Promise<{ ok: boolean; id?: string }> {
  const parent = (await getMessage(auth, convId, mid)) ?? { author: "?", preview: "", mri: "" };
  const quoteHtml = `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="${mid}"><strong itemprop="mri" itemid="${escapeHtml(parent.mri)}">${escapeHtml(parent.author)}</strong><span itemprop="time" itemid="${mid}"></span><p itemprop="preview">${escapeHtml(parent.preview)}</p></blockquote>`;
  const textHtml = toParagraphs(text);
  const bodyHtml = `${quoteHtml}${textHtml}`;

  const url = `${SERVER}/api/chatsvc/${auth.region}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages`;
  const body = JSON.stringify({
    content: bodyHtml,
    messagetype: "RichText/Html",
    contenttype: "Text",
    clientmessageid: clientMessageId(),
    properties: {
      qtdMsgs: [
        {
          messageId: Number(mid) || mid,
          sender: parent.mri,
          time: Number(mid) || mid,
          message: null,
          validationResult: "Valid",
          sharedRefId: null,
          replyChainId: null,
        },
      ],
    },
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Origin: SERVER,
      Referer: `${SERVER}/v2/`,
      Authorization: `Bearer ${auth.token}`,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    log.warn("chatsvc", `replyTextMessage HTTP ${resp.status}`, { error: errText.slice(0, 200), convId, mid });
    return { ok: false };
  }

  const json = (await resp.json().catch(() => ({}))) as { OriginalArrivalTime?: number };
  const id = json.OriginalArrivalTime ? String(json.OriginalArrivalTime) : String(Date.now());
  midConvCache.set(id, convId);
  getOptimistic(convId).added.set(id, {
    msg: {
      mid: id,
      author: "",
      text,
      mine: true,
      reacts: "",
      extra: extraOf({
        quote: { author: parent.author, text: parent.preview },
        status: "Sent",
        html: textHtml,
      }),
    },
    expiresAt: Date.now() + 8_000,
  });
  return { ok: true, id };
}

export async function editTextMessage(auth: TeamsAuth, convId: string, mid: string, text: string): Promise<boolean> {
  const url = `${SERVER}/api/chatsvc/${auth.region}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages/${mid}`;
  const htmlBody = toParagraphs(text);
  const body = JSON.stringify({
    content: htmlBody,
    messagetype: "RichText/Html",
    contenttype: "Text",
  });

  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Origin: SERVER,
      Referer: `${SERVER}/v2/`,
      Authorization: `Bearer ${auth.token}`,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    log.warn("chatsvc", `editTextMessage HTTP ${resp.status}`, { error: errText.slice(0, 200), convId, mid });
    return false;
  }
  getOptimistic(convId).edited.set(mid, { text, html: htmlBody, expiresAt: Date.now() + 8_000 });
  return true;
}

export async function deleteRemoteMessage(auth: TeamsAuth, convId: string, mid: string): Promise<boolean> {
  const url = `${SERVER}/api/chatsvc/${auth.region}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages/${mid}`;
  const resp = await fetch(url, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      Origin: SERVER,
      Referer: `${SERVER}/v2/`,
      Authorization: `Bearer ${auth.token}`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    log.warn("chatsvc", `deleteRemoteMessage HTTP ${resp.status}`, { error: errText.slice(0, 200), convId, mid });
    return false;
  }
  getOptimistic(convId).deleted.set(mid, Date.now() + 8_000);
  return true;
}

const EMOJI_TO_KEY: Record<string, string> = {
  like: "like",
  "👍": "like",
  heart: "heart",
  "❤️": "heart",
  "❤": "heart",
  laugh: "laugh",
  "😆": "laugh",
  surprised: "surprised",
  "😮": "surprised",
  cry: "sad",
  sad: "sad",
  "😢": "sad",
  angry: "angry",
  "😠": "angry",
};

export async function toggleMessageReaction(auth: TeamsAuth, convId: string, mid: string, emojiOrName: string): Promise<boolean> {
  const key = EMOJI_TO_KEY[emojiOrName.trim().toLowerCase()] ?? EMOJI_TO_KEY[emojiOrName.trim()];
  if (!key || !auth.oid) return false;

  try {
    const msgUrl = `${SERVER}/api/chatsvc/${auth.region}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages/${mid}`;
    const getResp = await fetch(msgUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        Origin: SERVER,
        Referer: `${SERVER}/v2/`,
        Authorization: `Bearer ${auth.token}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!getResp.ok) return false;
    const msg = (await getResp.json()) as RawTeamsMessage;
    const rawEmotions = typeof msg.properties?.emotions === "string"
      ? (() => { try { return JSON.parse(msg.properties!.emotions as string); } catch { return []; } })()
      : msg.properties?.emotions;
    const emotions = Array.isArray(rawEmotions) ? rawEmotions : [];
    const entry = emotions.find((e: { key?: string }) => String(e?.key || "").toLowerCase() === key);
    const users = Array.isArray(entry?.users) ? entry.users : [];
    const alreadyMine = users.some((u: { mri?: string }) => String(u?.mri || "").toLowerCase().includes(auth.oid!.toLowerCase()));

    const propUrl = `${msgUrl}/properties?name=emotions`;
    const method = alreadyMine ? "DELETE" : "PUT";
    const body = alreadyMine
      ? JSON.stringify({ emotions: { key } })
      : JSON.stringify({ emotions: { key, value: Date.now() } });

    const resp = await fetch(propUrl, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Origin: SERVER,
        Referer: `${SERVER}/v2/`,
        Authorization: `Bearer ${auth.token}`,
      },
      body,
      signal: AbortSignal.timeout(12_000),
    });
    return resp.ok;
  } catch (e) {
    log.warn("chatsvc", `toggleMessageReaction failed: ${errorText(e)}`, { convId, mid, key });
    return false;
  }
}

export async function uploadAmsImage(auth: TeamsAuth, imageBuffer: Buffer, mimeType = "image/png"): Promise<string | null> {
  try {
    const metaResp = await fetch("https://eu-api.asm.skype.com/v1/objects", {
      method: "POST",
      headers: {
        "User-Agent": AMS_USER_AGENT,
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "pish/image", permissions: { "users/ME": ["read"] } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!metaResp.ok) return null;
    const { id: objId } = (await metaResp.json()) as { id: string };

    const putResp = await fetch(`https://eu-api.asm.skype.com/v1/objects/${objId}/content/imgpsh`, {
      method: "PUT",
      headers: {
        "User-Agent": AMS_USER_AGENT,
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": mimeType,
      },
      body: new Uint8Array(imageBuffer),
      signal: AbortSignal.timeout(30_000),
    });
    if (!putResp.ok) return null;
    return objId;
  } catch (e) {
    log.warn("chatsvc", `uploadAmsImage failed: ${errorText(e)}`);
    return null;
  }
}

export async function sendImageMessage(auth: TeamsAuth, convId: string, imageBuffer: Buffer, mimeType = "image/png", caption = ""): Promise<{ ok: boolean; id?: string }> {
  const objId = await uploadAmsImage(auth, imageBuffer, mimeType);
  if (!objId) return { ok: false };

  const ext = mimeType.split("/").pop() || "png";
  const imgHtml = `<p><img src="https://eu-api.asm.skype.com/v1/objects/${objId}/views/imgo" itemtype="http://schema.skype.com/AMSImage" itemscope="${ext}" alt="immagine" id="x_${objId}" itemid="${objId}"></p>`;
  const captionHtml = caption.trim() ? toParagraphs(caption) : "";
  const fullHtml = `${imgHtml}${captionHtml}`;

  const url = `${SERVER}/api/chatsvc/${auth.region}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages`;
  const body = JSON.stringify({
    content: fullHtml,
    messagetype: "RichText/Html",
    contenttype: "Text",
    clientmessageid: clientMessageId(),
    amsreferences: [objId],
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Origin: SERVER,
      Referer: `${SERVER}/v2/`,
      Authorization: `Bearer ${auth.token}`,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) return { ok: false };
  const json = (await resp.json().catch(() => ({}))) as { OriginalArrivalTime?: number };
  const id = json.OriginalArrivalTime ? String(json.OriginalArrivalTime) : undefined;
  if (id) midConvCache.set(id, convId);
  return { ok: true, id };
}

export async function markConversationRead(auth: TeamsAuth, convId: string, fallbackMid?: string): Promise<boolean> {
  try {
    let last = lastMsgByConv.get(convId);
    if (!last) {
      const getUrl = `${SERVER}/api/chatsvc/${auth.region}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages?view=msnp24Equivalent&pageSize=1`;
      const getResp = await fetch(getUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          Origin: SERVER,
          Referer: `${SERVER}/v2/`,
          Authorization: `Bearer ${auth.token}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (getResp.ok) {
        const j = (await getResp.json()) as { messages?: RawTeamsMessage[] };
        const m0 = j.messages?.[0];
        if (m0?.id) last = { id: String(m0.id), cmid: String(m0.clientmessageid || m0.id) };
      }
    }
    const mid = last?.id || fallbackMid || String(Date.now());
    const cmid = last?.cmid || mid;
    const horizon = `${mid};${Date.now()};${cmid}`;

    const putUrl = `${SERVER}/api/chatsvc/${auth.region}/v1/users/ME/conversations/${encodeURIComponent(convId)}/properties?name=consumptionhorizon`;
    const resp = await fetch(putUrl, {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Origin: SERVER,
        Referer: `${SERVER}/v2/`,
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ consumptionhorizon: horizon }),
      signal: AbortSignal.timeout(10_000),
    });
    return resp.ok;
  } catch (e) {
    log.warn("chatsvc", `markConversationRead failed: ${errorText(e)}`, { convId });
    return false;
  }
}
