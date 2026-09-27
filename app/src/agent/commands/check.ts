import { z } from "zod";
import { parseState, STATE } from "@/shared/slot-db/state";
import { readActivity } from "../jobs/activity";
import { scanChatsFull } from "../jobs/chat-list";
import { errorText, log } from "../log";
import { RAIL_WAIT } from "./activity";
import type { Handler } from "./index";

// What was unread at the end of a check: each unread chat with its preview (a new message changes it), the ids of the
// unread Activity items and of every missed call as the last feed read showed them (Teams shows a missed call as read,
// new or not: a new one is an id that was not there), and whether any feed was read (a row of an earlier release,
// without it, was written after one). A row without calls, from an earlier release, pushes no missed call: the check
// only records them.
const Seen = z.object({
  chats: z.array(z.string()).catch([]),
  activity: z.array(z.string()).catch([]),
  calls: z.array(z.string()).optional().catch(undefined),
  read: z.boolean().catch(true),
});

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The check of an account the web app starts only to check it (checked every N hours, src/lib/checks.ts): the whole
// chat list and the Activity feed, then a push for each missed call of the feed that was not there at the previous
// check, and one more when a chat or another notification is unread that was not. The browser did not run while
// those calls rang: the feed is all that tells them. The messages that came meanwhile are not pushed one by one: the
// first chat list after a start only primes the detector. The first check after the web app set the mode or started
// the account again primes too (it forgets the last one, src/lib/slots.ts), and notifications and missed calls are
// compared only between two feeds read.
export const check: Handler = async (a) => {
  const chats = await scanChatsFull(a);
  const feed = await readActivity(a, RAIL_WAIT);
  const unread = a.store.chats().filter((c) => c.unread && !c.muted && !/\(you\)/i.test(c.name));
  const before = a.store.getState(STATE.checkSeen);
  const was = before ? parseState(Seen, before, { chats: [], activity: [], read: true }) : null;
  const read = feed !== null;
  const calls = read ? a.store.missedCalls() : [];
  // a feed not read (an empty one reads the same) keeps the notifications and the missed calls of the last read
  const now = {
    chats: unread.map((c) => `${c.name}\n${c.preview}`),
    activity: read ? a.store.unreadActivity() : (was?.activity ?? []),
    calls: read ? calls.map((c) => c.id) : was?.calls,
    read: read || !!was?.read,
  };
  // recorded before the pushes: a check cut short (its account stopped after the command wait) pushes none of it again
  a.store.setState(STATE.checkSeen, JSON.stringify(now));
  if (was) {
    const compare = read && was.read;
    const known = compare && was.calls ? new Set(was.calls) : null;
    const missed = known ? calls.filter((c) => !known.has(c.id)) : [];
    const callIds = new Set(calls.map((c) => c.id));
    const newChats = now.chats.filter((c) => !was.chats.includes(c)).length;
    const newItems = compare ? now.activity.filter((id) => !was.activity.includes(id) && !callIds.has(id)).length : 0;
    const pushes: Promise<unknown>[] = missed.map((c) => a.notifier.missedCall(c.caller, c.time));
    if (newChats || newItems) {
      const found = [unread.length > 0 && plural(unread.length, "unread chat", "unread chats"), newItems > 0 && plural(newItems, "new notification", "new notifications")];
      pushes.push(a.notifier.alert(found.filter(Boolean).join(", "), "Found by the check: open TeamsRelay to read them."));
    }
    for (const r of await Promise.allSettled(pushes)) if (r.status === "rejected") log.warn("check", `push: ${errorText(r.reason)}`);
  }
  if (!read) log.warn("check", "Activity feed not read: notifications as last read");
  return chats !== null ? "done" : "failed";
};
