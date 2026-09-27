import type { Agent } from "../context";
import { CallTracker } from "../logic/calls";
import { isTeamsUrl } from "../logic/hosts";
import { errorText, log } from "../log";
import { readIncomingCall } from "../teams/scripts/calls";
import { SEL, TEXTS } from "../teams/selectors";

// Seconds between two looks for a call
export const CALL_WATCH_EVERY = 1;

// An incoming call, pushed as soon as its toast shows and followed until it stops (logic/calls.ts). Teams web rings
// a few seconds only, so the watch runs on a timer of its own, beside the loop: a round can take many seconds (the
// whole chat list, the Activity feed, a send). It only reads the page; a look that fails (the page navigating) says
// nothing about the call.
export class CallWatch {
  private readonly tracker: CallTracker;
  private busy = false;
  private warned = 0;

  constructor(
    private readonly a: Pick<Agent, "notifier"> & { tp?: Agent["tp"] },
    private readonly clock: () => number = () => performance.now(),
    wall: () => number = Date.now,
  ) {
    this.tracker = new CallTracker(clock, wall);
  }

  start(signal?: AbortSignal) {
    const timer = setInterval(() => void this.tick(), CALL_WATCH_EVERY * 1000);
    signal?.addEventListener("abort", () => clearInterval(timer));
  }

  // One look at a time: a look still waiting for the page skips the next ones
  async tick() {
    const page = this.a.tp?.page;
    if (this.busy || !page || page.isClosed() || !isTeamsUrl(page.url())) return;
    this.busy = true;
    try {
      const event = this.tracker.update(await page.evaluate(readIncomingCall, { s: SEL, t: TEXTS }));
      if (event?.kind === "ringing") {
        if (!event.again) log.info("call", "ringing", { caller: event.caller });
        await this.a.notifier.call(event.caller, event.again ? "again" : "ringing", event.since);
      } else if (event) {
        log.info("call", "ended", { caller: event.caller, seconds: event.seconds });
        await this.a.notifier.call(event.caller, "ended", event.since, event.seconds);
      }
    } catch (e) {
      // a page that navigates fails every look for a while: one line a minute
      if (!this.warned || this.clock() - this.warned > 60_000) {
        log.warn("call", errorText(e));
        this.warned = this.clock();
      }
    } finally {
      this.busy = false;
    }
  }
}
