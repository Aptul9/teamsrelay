import { TEXTS } from "../teams/selectors";

// "Read by" in group chats, collected in the background: Teams shows it only in the menu of each message, so
// the agent reads it when idle, one message at a time, for your last messages of the open chat.
export const READBY_RECENT = 5;
// seconds between two reads of the same message, until everybody read it
export const READBY_EVERY = 60;

export function readByDone(label: string): boolean {
  const m = TEXTS.readBy.exec(label || "");
  return !!m && m[1] === m[2];
}

// Your recent messages whose "Read by" is unknown, or not complete and older than READBY_EVERY
export function readByTodo(mine: readonly string[], known: ReadonlyMap<string, { label: string; ts: number }>, nowSeconds: number): string[] {
  return mine.filter((mid) => {
    const k = known.get(mid);
    return !k || (!readByDone(k.label) && nowSeconds - k.ts > READBY_EVERY);
  });
}
