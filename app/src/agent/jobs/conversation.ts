import { parseState, STATE, Viewing } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { imageKey } from "../logic/files";
import { extraOf } from "../logic/messages";
import { errorText, log } from "../log";
import { fetchChatMessages, getTeamsAuth, markConversationRead, resolveConversationId } from "../teams/chatsvc";
import { readMessages } from "../teams/scripts/conversation";
import { SEL, TEXTS } from "../teams/selectors";
import type { SavedMessage } from "../store/slot-store";

// The chat is on screen in the app: without a mark the agent parks Teams on the self chat after PARK_AFTER seconds. A
// command marks the chat it acts on, unless the app stopped showing a chat after queueing it (since: when it was
// queued, Unix s): Teams then leaves the chat as the app did.
export function markViewing(a: Agent, chat: string, since = 0) {
  const shown = parseState(Viewing, a.store.getState(STATE.viewing));
  if (since && !shown.chat && shown.ts >= since) return;
  a.store.setState(STATE.viewing, JSON.stringify({ chat, ts: nowSeconds() }));
}

// Messages of the chat open in Teams; null when Teams shows another chat or the page could not be read
export async function readOpenMessages(a: Agent, chat: string): Promise<SavedMessage[] | null> {
  const page = a.tp.page;
  let rows;
  try {
    if (!(await a.tp.isOpen(chat))) return null;
    rows = await page.evaluate(readMessages, { s: SEL, t: TEXTS });
  } catch (e) {
    log.warn("messages", errorText(e), { chat });
    return null;
  }
  const readBy = a.store.readByCache(rows.filter((m) => m.mine && m.mid).map((m) => m.mid));
  const budget = { left: 8 };
  const out: SavedMessage[] = [];
  for (const m of rows) {
    const images: { f?: string; url?: string; w: number; h: number }[] = [];
    for (const [i, im] of m.images.entries()) {
      const f = await a.media.image(page, imageKey(chat, m.mid, i), im.src);
      if (f) images.push({ f, w: im.w, h: im.h });
      // the address of an image Teams has not loaded yet works only inside the Teams session
      else if (im.loaded && im.src.startsWith("https://")) images.push({ url: im.src, w: im.w, h: im.h });
    }
    const av = await a.media.avatar(page, m.avsrc, budget);
    const extra = extraOf({
      quote: m.quote ?? undefined,
      images,
      files: m.files,
      reactions: m.reactions,
      status: m.status,
      edited: m.edited,
      readby: readBy.get(m.mid),
      html: m.html,
      mentionsMe: m.mentionsMe,
      av,
      deleted: m.deleted,
    });
    out.push({ mid: m.mid, author: m.author, text: m.text, mine: m.mine, reacts: m.reacts, extra });
  }
  return out;
}

const recentlyReadChats = new Map<string, { preview: string; until: number }>();

export function isRecentlyRead(chat: string, preview: string): boolean {
  const entry = recentlyReadChats.get(chat);
  if (!entry) return false;
  if (Date.now() > entry.until || (preview && entry.preview && preview !== entry.preview)) {
    recentlyReadChats.delete(chat);
    return false;
  }
  return true;
}

export async function markReadViaApi(a: Agent, chat: string): Promise<void> {
  try {
    const entry = a.store.chats().find((c) => c.name === chat);
    recentlyReadChats.set(chat, { preview: entry?.preview ?? "", until: Date.now() + 20_000 });
    a.store.markChatRead(chat);

    const page = a.tp?.page;
    if (!page || typeof page.context !== "function") return;
    const auth = await getTeamsAuth(page.context(), page);
    if (!auth) return;
    const convId = await resolveConversationId(auth, page, chat);
    if (!convId) return;
    const lastMid = a.store.messages(chat).at(-1)?.mid;
    await markConversationRead(auth, convId, lastMid);
  } catch (e) {
    log.warn("messages", `markReadViaApi failed: ${errorText(e)}`, { chat });
  }
}

// Chats chatsvc saved at the last try: only these can skip Teams. Any other chat is read from the page, or it stays as
// it was saved.
const savedByApi = new Set<string>();

export const servedByApi = (chat: string) => savedByApi.has(chat);

// Fast path: fetch messages directly via chatsvc API without requiring DOM navigation
export async function saveChatViaApi(a: Agent, chat: string): Promise<boolean> {
  const saved = await saveThroughApi(a, chat);
  if (saved) savedByApi.add(chat);
  else savedByApi.delete(chat);
  return saved;
}

async function saveThroughApi(a: Agent, chat: string): Promise<boolean> {
  try {
    const page = a.tp?.page;
    if (!page || typeof page.context !== "function") return false;
    const auth = await getTeamsAuth(page.context(), page);
    if (!auth) return false;
    const convId = await resolveConversationId(auth, page, chat);
    if (!convId) return false;
    const messages = await fetchChatMessages(auth, convId, (mids) => a.store.readByCache(mids));
    if (!messages) return false;

    const existing = a.store.messages(chat);
    const prevByMid = new Map(existing.map((m) => [m.mid, m]));
    const authorAv = new Map<string, string>();
    for (const m of existing) {
      if (m.author && m.av) authorAv.set(m.author, m.av);
    }
    const chatEntry = a.store.chats().find((c) => c.name === chat);
    const defaultAv = chatEntry?.kind === "one" && chatEntry.av ? chatEntry.av : "";

    for (const m of messages) {
      const prev = prevByMid.get(m.mid);
      const av = prev?.av || (m.author ? authorAv.get(m.author) : "") || (!m.mine ? defaultAv : "") || "";
      const status = prev?.status && /seen/i.test(prev.status) ? prev.status : m.extra?.status;

      let resolvedImages = m.extra?.images;
      if (resolvedImages?.length) {
        const resolved: { f?: string; url?: string; w: number; h: number }[] = [];
        for (const [i, im] of resolvedImages.entries()) {
          const prevIm = prev?.images?.[i];
          if (prevIm?.f) {
            resolved.push({ f: prevIm.f, w: prevIm.w ?? im.w ?? 0, h: prevIm.h ?? im.h ?? 0 });
            continue;
          }
          const src = im.url || "";
          const f = src ? await a.media.image(page, imageKey(chat, m.mid, i), src) : null;
          if (f) resolved.push({ f, w: im.w ?? 0, h: im.h ?? 0 });
          else if (src.startsWith("https://")) resolved.push({ url: src, w: im.w ?? 0, h: im.h ?? 0 });
        }
        resolvedImages = resolved.length ? resolved : undefined;
      }

      m.extra = extraOf({
        ...m.extra,
        images: resolvedImages,
        status,
        av,
      });
    }
    a.store.saveChatMessages(chat, messages);
    return true;
  } catch (e) {
    log.warn("messages", `chatsvc save failed: ${errorText(e)}`, { chat });
    return false;
  }
}

// True once the messages Teams shows for the chat are saved
export async function saveOpenChat(a: Agent, chat: string): Promise<boolean> {
  if (await saveChatViaApi(a, chat)) return true;
  const messages = await readOpenMessages(a, chat);
  if (messages) a.store.saveChatMessages(chat, messages);
  return !!messages;
}
