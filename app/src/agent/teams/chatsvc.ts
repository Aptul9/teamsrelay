import crypto from "node:crypto";
import type { BrowserContext, Page } from "playwright-core";
import { errorText, log } from "../log";

export type TeamsAuth = {
  token: string;
  region: string;
};

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
const AMS_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SkypeSpaces/1410/0.0.0.0";
const SERVER = "https://teams.microsoft.com";

// Extract authtoken_asm and region from BrowserContext cookies
export async function getTeamsAuth(context: BrowserContext): Promise<TeamsAuth | null> {
  try {
    const cookies = await context.cookies();
    const asm =
      cookies.find((c) => c.name === "authtoken_asm" && (c.domain.includes("asyncgw.teams.microsoft.com") || c.domain.includes("teams.microsoft.com") || c.domain.includes("teams.cloud.microsoft"))) ??
      cookies.find((c) => c.name === "authtoken_asm");

    if (!asm?.value) return null;

    let token = asm.value;
    if (token.toLowerCase().startsWith("bearer%20")) token = token.slice(9);
    else if (token.toLowerCase().startsWith("bearer ")) token = token.slice(7);
    else if (token.toLowerCase().startsWith("bearer=")) token = token.slice(7);
    token = decodeURIComponent(token);

    // Region: from authtoken path (e.g. /api/mt/part/emea-03/...) or default "emea"
    let region = "emea";
    const authCookie = cookies.find((c) => c.name === "authtoken" && c.domain.includes("teams.microsoft.com"));
    if (authCookie?.path) {
      const parts = authCookie.path.split("/").filter(Boolean);
      const mtIdx = parts.indexOf("mt");
      if (mtIdx !== -1 && mtIdx + 1 < parts.length) {
        let r = parts[mtIdx + 1];
        if (r === "part" && mtIdx + 2 < parts.length) r = parts[mtIdx + 2];
        region = r.split("-")[0];
      }
    }

    return { token, region };
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

// Cache of chat name to conversation ID
const convCache = new Map<string, { id: string; expiresAt: number }>();

export async function resolveConversationId(auth: TeamsAuth, page: Page, chat: string): Promise<string | null> {
  // 1. Direct ID
  if (chat.startsWith("19:") || chat.startsWith("48:")) return chat;

  // 2. Active open conversation in page
  const openId = await getOpenConversationId(page);
  if (openId) {
    convCache.set(chat, { id: openId, expiresAt: Date.now() + 15 * 60_000 });
    return openId;
  }

  // 3. Cache lookup
  const hit = convCache.get(chat);
  if (hit && Date.now() < hit.expiresAt) return hit.id;

  // 4. API directory lookup
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
      const data = (await resp.json()) as { conversations?: Array<{ id?: string; threadProperties?: { topic?: string; spaceThreadTopic?: string; threadTopic?: string } }> };
      for (const c of data.conversations ?? []) {
        if (!c.id) continue;
        const tp = c.threadProperties ?? {};
        const title = tp.topic || tp.spaceThreadTopic || tp.threadTopic;
        if (title) {
          convCache.set(title, { id: c.id, expiresAt: Date.now() + 15 * 60_000 });
          if (title.toLowerCase() === chat.toLowerCase()) return c.id;
        }
      }
    }
  } catch (e) {
    log.warn("chatsvc", `resolveConversationId failed: ${errorText(e)}`, { chat });
  }

  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
}

function toParagraphs(text: string): string {
  const lines = text.split("\n");
  return lines.map((line) => `<p>${line.trim() ? escapeHtml(line) : "&nbsp;"}</p>`).join("");
}

function clientMessageId(): string {
  return `${Date.now()}${crypto.randomInt(100, 999)}`;
}

export async function sendTextMessage(auth: TeamsAuth, convId: string, text: string): Promise<{ ok: boolean; id?: string }> {
  const url = `${SERVER}/api/chatsvc/${auth.region}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages`;
  const body = JSON.stringify({
    content: toParagraphs(text),
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
  return { ok: true, id: json.OriginalArrivalTime ? String(json.OriginalArrivalTime) : undefined };
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
  const bodyHtml = `${quoteHtml}${toParagraphs(text)}`;

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
  return { ok: true, id: json.OriginalArrivalTime ? String(json.OriginalArrivalTime) : undefined };
}

export async function editTextMessage(auth: TeamsAuth, convId: string, mid: string, text: string): Promise<boolean> {
  const url = `${SERVER}/api/chatsvc/${auth.region}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages/${mid}`;
  const body = JSON.stringify({
    content: toParagraphs(text),
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
  return true;
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
  return { ok: true, id: json.OriginalArrivalTime ? String(json.OriginalArrivalTime) : undefined };
}
