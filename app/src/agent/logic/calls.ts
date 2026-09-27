// An incoming call as the agent follows it from the toast Teams shows: pushed as soon as it rings, pushed again
// every CALL_RING_EVERY seconds while it rings (the phone alerts at every push), for CALL_RING_FOR seconds at most,
// and once more when the toast has been gone CALL_END_AFTER seconds: Teams may draw it again at once. Teams web
// rang 5 to 9 s in the tests of 2026-09-27 before voicemail or the caller ended the call.
export const CALL_RING_EVERY = 5;
export const CALL_RING_FOR = 60;
export const CALL_END_AFTER = 2;

// since: when it started ringing (ms), the time the notification shows; seconds: how long the toast showed
export type CallEvent = { kind: "ringing"; caller: string; since: number; again: boolean } | { kind: "ended"; caller: string; since: number; seconds: number };

export class CallTracker {
  private call: { caller: string; since: number; rang: number; seen: number; gone: number } | null = null;

  constructor(private readonly clock: () => number = Date.now) {}

  // What to push for what the page shows now: the call ringing, or none
  update(shown: { caller: string } | null): CallEvent | null {
    const now = this.clock();
    const c = this.call;
    if (shown) {
      if (!c || c.caller !== shown.caller) {
        this.call = { caller: shown.caller, since: now, rang: now, seen: now, gone: 0 };
        return { kind: "ringing", caller: shown.caller, since: now, again: false };
      }
      c.seen = now;
      c.gone = 0;
      if (now - c.rang < CALL_RING_EVERY * 1000 || now - c.since >= CALL_RING_FOR * 1000) return null;
      c.rang = now;
      return { kind: "ringing", caller: c.caller, since: c.since, again: true };
    }
    if (!c) return null;
    if (!c.gone) c.gone = now;
    if (now - c.gone < CALL_END_AFTER * 1000) return null;
    this.call = null;
    return { kind: "ended", caller: c.caller, since: c.since, seconds: Math.round((c.seen - c.since) / 1000) };
  }
}
