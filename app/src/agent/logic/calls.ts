// An incoming call as the agent follows it from the toast Teams shows: pushed as soon as it rings, pushed again
// every CALL_RING_EVERY seconds while it rings (the phone alerts at every push), for CALL_RING_FOR seconds at most,
// and once more when the toast has been gone CALL_END_AFTER seconds: Teams may draw it again at once. Teams web
// rang 5 to 9 s in the tests of 2026-09-27 before voicemail or the caller ended the call.
export const CALL_RING_EVERY = 5;
export const CALL_RING_FOR = 60;
export const CALL_END_AFTER = 2;

// since: when it started ringing (ms on the wall clock), the time the notification shows; seconds: how long the
// toast showed; replaced: the call of another caller whose toast this one took over before it could end
export type EndedCall = { caller: string; since: number; seconds: number };
export type CallEvent = { kind: "ringing"; caller: string; since: number; again: boolean; replaced?: EndedCall } | ({ kind: "ended" } & EndedCall);

// Durations run on `clock`, which only goes forward (performance.now): the wall clock set back during a call would
// keep it ringing. A caller without a name (text not read yet, or for a moment) is the call already ringing.
export class CallTracker {
  private call: { caller: string; since: number; start: number; rang: number; seen: number; gone: number } | null = null;

  constructor(
    private readonly clock: () => number = () => performance.now(),
    private readonly wall: () => number = Date.now,
  ) {}

  // What to push for what the page shows now: the call ringing, or none
  update(shown: { caller: string } | null): CallEvent | null {
    const now = this.clock();
    const c = this.call;
    if (shown) {
      if (!c || (c.caller && shown.caller && c.caller !== shown.caller)) {
        const since = this.wall();
        this.call = { caller: shown.caller, since, start: now, rang: now, seen: now, gone: -1 };
        const replaced = c ? { replaced: { caller: c.caller, since: c.since, seconds: Math.round((c.seen - c.start) / 1000) } } : {};
        return { kind: "ringing", caller: shown.caller, since, again: false, ...replaced };
      }
      c.caller ||= shown.caller;
      c.seen = now;
      c.gone = -1;
      if (now - c.rang < CALL_RING_EVERY * 1000 || now - c.start >= CALL_RING_FOR * 1000) return null;
      c.rang = now;
      return { kind: "ringing", caller: c.caller, since: c.since, again: true };
    }
    if (!c) return null;
    if (c.gone < 0) c.gone = now;
    if (now - c.gone < CALL_END_AFTER * 1000) return null;
    this.call = null;
    return { kind: "ended", caller: c.caller, since: c.since, seconds: Math.round((c.seen - c.start) / 1000) };
  }

  // The call whose toast shows now, for as long as it is pushed (CALL_RING_FOR)
  current(): { caller: string; since: number } | null {
    const c = this.call;
    if (!c || c.gone >= 0 || this.clock() - c.start >= CALL_RING_FOR * 1000) return null;
    return { caller: c.caller, since: c.since };
  }
}
