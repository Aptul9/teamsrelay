import { presenceOf } from "@/shared/presence";
import { STATE } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { CHAT_LIMIT, type ChatEntry } from "../logic/chats";
import { errorText, log } from "../log";
import { sleep } from "../teams/page";
import { readChatList, scrollChatList, type ListRow } from "../teams/scripts/chat-list";
import { SEL, TEXTS } from "../teams/selectors";

// The rows as Teams shows them, the presence of each person as one of the words the app knows
export const readList = async (a: Agent): Promise<ListRow[]> =>
  (await a.tp.page.evaluate(readChatList, { s: SEL, t: TEXTS })).map((r) => ({ ...r, presence: presenceOf(r.presence) }));

// A list read saved without copying pictures: the known ones stay
export const withoutPictures = (rows: readonly ListRow[]): ChatEntry[] =>
  rows.map(({ name, preview, time, unread, mention, muted, presence }) => ({ name, preview, time, unread, mention, muted, av: "", presence }));

// New messages found in a list read: history, ntfy, push
export async function notifyNew(a: Agent, rows: readonly ListRow[]) {
  for (const { chat, body } of a.detector.scan(rows)) {
    log.info("NEWMSG", chat, { preview: body.slice(0, 50) });
    await a.notifier.message(chat, body, chat);
  }
}

// The chats Teams has in the page: pictures (up to 8 new ones), list saved on top of the known one, new messages
export async function scanChats(a: Agent) {
  try {
    const rows = await readList(a);
    if (!rows.length) return;
    a.store.saveChats(await a.media.avatars(a.tp.page, rows));
    a.store.setState(STATE.lastScanTs, String(nowSeconds()));
    await notifyNew(a, rows);
  } catch (e) {
    log.warn("chats", errorText(e));
  }
}

// The whole list, scrolled from the top (it is virtualized), saved complete and in order in one transaction,
// then back to the top. Number of chats read, null when the read failed.
export async function scanChatsFull(a: Agent): Promise<number | null> {
  const page = a.tp.page;
  try {
    await page.evaluate(scrollChatList, { s: SEL, to: "top" as const });
    await sleep(400);
    const seen = new Map<string, ChatEntry>();
    for (let i = 0; i < 8; i++) {
      for (const c of await a.media.avatars(page, await readList(a), 20)) seen.set(c.name, c);
      if (seen.size >= CHAT_LIMIT || !(await page.evaluate(scrollChatList, { s: SEL, to: "down" as const }))) break;
      await sleep(500);
    }
    await page.evaluate(scrollChatList, { s: SEL, to: "top" as const });
    if (!seen.size) return 0;
    a.store.saveChats([...seen.values()].slice(0, CHAT_LIMIT), true);
    a.store.setState(STATE.lastScanTs, String(nowSeconds()));
    return seen.size;
  } catch (e) {
    log.warn("chats", `full list: ${errorText(e)}`);
    return null;
  }
}
