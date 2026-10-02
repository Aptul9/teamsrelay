import { parseState, STATE, Viewing } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { imageKey } from "../logic/files";
import { extraOf } from "../logic/messages";
import { errorText, log } from "../log";
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

// True once the messages Teams shows for the chat are saved
export async function saveOpenChat(a: Agent, chat: string): Promise<boolean> {
  const messages = await readOpenMessages(a, chat);
  if (messages) a.store.saveChatMessages(chat, messages);
  return !!messages;
}
