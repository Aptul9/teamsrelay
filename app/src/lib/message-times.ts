// Times of the messages of a chat. Teams names a message by the time it was sent, epoch ms (data-mid): the time comes
// from the id, with no column of its own.

// Consecutive messages of one person make one group, as in Teams, until a pause longer than this or another day
export const GROUP_GAP = 5 * 60_000;

// When a message was sent, from its Teams id; null for an id that is not a time
export function sentAt(mid: string | number | undefined): number | null {
  const s = String(mid ?? "");
  return /^1\d{12}$/.test(s) ? Number(s) : null;
}

export const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

// For each message: whether it starts a group (author, picture and time above it) and whether it is the first of its
// day (a divider above it). A message without a time breaks no group and starts no day.
export function placeMessages(messages: { mid: string | number; author: string; mine: number | boolean }[]): { first: boolean; day: boolean }[] {
  let prev: { author: string | null; mine: boolean; at: number | null } | null = null;
  return messages.map((m) => {
    const mine = !!m.mine;
    const at = sentAt(m.mid);
    const last = prev?.at ?? null;
    const day = at !== null && (last === null || !sameDay(last, at));
    const pause = at !== null && last !== null && at - last > GROUP_GAP;
    const first = !prev || (mine ? !prev.mine : m.author !== prev.author || prev.mine) || pause || day;
    prev = { author: mine ? null : m.author, mine, at: at ?? last };
    return { first, day };
  });
}

// The divider above the first message of a day: Today, Yesterday, else the day, with the year when it is another one
export function dayLabel(at: number, now = Date.now()): string {
  const today = new Date(now);
  if (sameDay(at, now)) return "Today";
  if (sameDay(at, new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime())) return "Yesterday";
  const d = new Date(at);
  const year = d.getFullYear() !== today.getFullYear();
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...(year && { year: "numeric" }) });
}

// The time above a group, as the device writes it (13:56, 1:56 PM)
export const timeLabel = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

// Day and time of one message, shown on hover
export const fullTime = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
