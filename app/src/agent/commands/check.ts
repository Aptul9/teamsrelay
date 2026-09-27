import { z } from "zod";
import { parseState, STATE } from "@/shared/slot-db/state";
import { readActivity } from "../jobs/activity";
import { scanChatsFull } from "../jobs/chat-list";
import { RAIL_WAIT } from "./activity";
import type { Handler } from "./index";

// What was unread at the end of a check: each unread chat with its preview (a new message changes it), the ids of the
// unread Activity items
const Seen = z.object({ chats: z.array(z.string()).catch([]), activity: z.array(z.string()).catch([]) });

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The check of an account the web app starts only to check it (checked every N hours, src/lib/checks.ts): the whole
// chat list and the Activity feed, then one push when a chat or a notification is unread that was not at the previous
// check. The messages that came meanwhile are not pushed one by one: the first chat list after a start only primes
// the detector.
export const check: Handler = async (a) => {
  const chats = await scanChatsFull(a);
  const feed = await readActivity(a, RAIL_WAIT);
  const unread = a.store.chats().filter((c) => c.unread && !c.muted && !/\(you\)/i.test(c.name));
  const now = { chats: unread.map((c) => `${c.name}\n${c.preview}`), activity: a.store.unreadActivity() };
  const before = a.store.getState(STATE.checkSeen);
  if (before) {
    const was = parseState(Seen, before, { chats: [], activity: [] });
    const newChats = now.chats.filter((c) => !was.chats.includes(c)).length;
    const newItems = now.activity.filter((id) => !was.activity.includes(id)).length;
    if (newChats || newItems) {
      const found = [unread.length > 0 && plural(unread.length, "unread chat", "unread chats"), newItems > 0 && plural(newItems, "new notification", "new notifications")];
      await a.notifier.alert(found.filter(Boolean).join(", "), "Found by the check: open TeamsRelay to read them.");
    }
  }
  a.store.setState(STATE.checkSeen, JSON.stringify(now));
  return chats !== null && feed !== null ? "done" : "failed";
};
