import { presenceOf } from "@/shared/presence";
import { STATE } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { CHAT_LIMIT, type ChatEntry } from "../logic/chats";
import { errorText, log } from "../log";
import { sleep } from "../teams/page";
import { readChatList, scrollList, type ListRow } from "../teams/scripts/chat-list";
import { SEL, TEXTS } from "../teams/selectors";
import { inApp } from "./page-setup";

// The rows as Teams shows them, the presence of each person as one of the words the app knows
export const readList = async (a: Agent): Promise<ListRow[]> =>
  (await a.tp.page.evaluate(readChatList, { s: SEL, t: TEXTS })).map((r) => ({ ...r, presence: presenceOf(r.presence) }));

// A list read saved without copying pictures: the known ones stay
export const withoutPictures = (rows: readonly ListRow[]): ChatEntry[] =>
  rows.map(({ name, preview, time, unread, mention, muted, presence, kind }) => ({ name, preview, time, unread, mention, muted, av: "", presence, kind }));

// New messages found in a list read: history, ntfy, push; none for the chat the app shows now, read there as it comes
export async function notifyNew(a: Agent, rows: readonly ListRow[]) {
  for (const { chat, body } of a.detector.scan(rows)) {
    const shown = inApp(a, chat);
    log.info("NEWMSG", chat, { preview: body.slice(0, 50), inApp: shown || undefined });
    if (!shown) await a.notifier.message(chat, body, chat);
  }
}

// The chats Teams has in the page: saved on top of the known ones, pictures copied (up to 8 new ones) or not, then
// their new messages. False when Teams shows no row.
export async function readChats(a: Agent, pictures: boolean): Promise<boolean> {
  const rows = await readList(a);
  if (!rows.length) return false;
  a.store.saveChats(pictures ? await a.media.avatars(a.tp.page, rows) : withoutPictures(rows));
  a.store.setState(STATE.lastScanTs, String(nowSeconds()));
  await notifyNew(a, rows);
  return true;
}

export async function scanChats(a: Agent) {
  try {
    await readChats(a, true);
  } catch (e) {
    log.warn("chats", errorText(e));
  }
}

// The whole list, scrolled from the top (it is virtualized), saved complete and in order in one transaction,
// then back to the top. Number of chats read, null when the read failed.
export async function scanChatsFull(a: Agent): Promise<number | null> {
  const page = a.tp.page;
  try {
    await page.evaluate(scrollList, { item: SEL.anyChatRow, to: "top" as const });
    await sleep(400);
    const seen = new Map<string, ChatEntry>();
    for (let i = 0; i < 8; i++) {
      for (const c of await a.media.avatars(page, await readList(a), 20)) seen.set(c.name, c);
      if (seen.size >= CHAT_LIMIT || !(await page.evaluate(scrollList, { item: SEL.anyChatRow, to: "down" as const }))) break;
      await sleep(500);
    }
    await page.evaluate(scrollList, { item: SEL.anyChatRow, to: "top" as const });
    if (!seen.size) return 0;
    a.store.saveChats([...seen.values()].slice(0, CHAT_LIMIT), true);
    a.store.setState(STATE.lastScanTs, String(nowSeconds()));
    return seen.size;
  } catch (e) {
    log.warn("chats", `full list: ${errorText(e)}`);
    return null;
  }
}
