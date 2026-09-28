import { z } from "zod";
import { parseState, STATE } from "@/shared/slot-db/state";
import type { Agent } from "../context";
import { errorText, log } from "../log";

// Seconds after a call ends to read the Activity feed, where Teams lists it once missed (an answered call leaves
// nothing there): soon, and once more for a Teams slow to list it
export const FEED_AFTER_CALL = [8, 40] as const;

// ids kept of the missed calls already alerted, newest first
const KEEP = 200;

// When the feed of an account always on is read out of its turn, which comes every 150 rounds: a few seconds after
// each call that ended, and once more later
export class FeedAfterCalls {
  private at: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  callEnded() {
    const t = this.now();
    this.at = [...this.at, ...FEED_AFTER_CALL.map((s) => t + s * 1000)].sort((x, y) => x - y);
  }

  due(): boolean {
    return this.at.length > 0 && this.at[0] <= this.now();
  }

  // A read of the feed just started: it covers every time already past
  ran() {
    const t = this.now();
    this.at = this.at.filter((x) => x > t);
  }
}

const Ids = z.array(z.string()).catch([]);
const CheckCalls = z.object({ calls: z.array(z.string()).optional().catch(undefined) }).catch({ calls: undefined });

// Each missed call of the feed that no push told yet alerts once, with who called and the time Teams shows. The
// first feed an account reads only records what it has: an agent that starts pushes none of the past. The calls the
// check pushed while the account was checked every N hours count as told. Recorded before the pushes: one that fails
// is not pushed again. Number of new missed calls.
export async function pushMissedCalls(a: Pick<Agent, "store" | "notifier">): Promise<number> {
  const calls = a.store.missedCalls();
  const raw = a.store.getState(STATE.callsTold);
  const told = raw ? parseState(Ids, raw, []) : null;
  const checked = parseState(CheckCalls, a.store.getState(STATE.checkSeen), { calls: undefined }).calls ?? [];
  const known = new Set([...(told ?? []), ...checked]);
  const fresh = told ? calls.filter((c) => !known.has(c.id)) : [];
  a.store.setState(STATE.callsTold, JSON.stringify([...new Set([...calls.map((c) => c.id), ...(told ?? [])])].slice(0, KEEP)));
  const pushes = fresh.map((c) => a.notifier.alert(c.caller ? `Missed call from ${c.caller}` : "Missed call", `Teams call${c.time ? ` at ${c.time}` : ""}, not answered`));
  for (const r of await Promise.allSettled(pushes)) if (r.status === "rejected") log.warn("calls", `push: ${errorText(r.reason)}`);
  if (fresh.length) log.info("calls", "missed", { calls: fresh.length });
  return fresh.length;
}
