import { CALL_SEEN_EVERY, STATE, type CallState } from "@/shared/slot-db/state";
import type { Agent } from "../context";
import { CallTracker, type EndedCall } from "../logic/calls";
import { isTeamsUrl } from "../logic/hosts";
import { errorText, log } from "../log";
import { readIncomingCall } from "../teams/scripts/calls";
import { SEL, TEXTS } from "../teams/selectors";

// Seconds between two looks for a call
export const CALL_WATCH_EVERY = 1;

// An incoming call, pushed as soon as its toast shows and followed until it stops (logic/calls.ts). Teams web rings
// a few seconds only, so the watch runs on a timer of its own, beside the loop: a round can take many seconds (the
// whole chat list, the Activity feed, a send). It only reads the page; a look that fails (the page navigating) says
// nothing about the call. The call is also kept in the slot database for the web app, which rings while it is open,
// and each call that ended goes to the call log of the account. The pushes of a call go out one after the other, in
// the background: a push service slow to answer (up to 15 s) holds up neither the looks nor the web app. ended: told
// of each call that ended, gone or replaced by another; the Activity feed read soon after says whether it was missed.
export class CallWatch {
  private readonly tracker: CallTracker;
  private busy = false;
  private warned = 0;
  private written = 0;
  private pushes: Promise<void> = Promise.resolve();

  constructor(
    private readonly a: Pick<Agent, "notifier" | "store"> & { tp?: Agent["tp"] },
    private readonly clock: () => number = () => performance.now(),
    private readonly wall: () => number = Date.now,
    private readonly ended: () => void = () => {},
  ) {
    this.tracker = new CallTracker(clock, wall);
  }

  start(signal?: AbortSignal) {
    const timer = setInterval(() => void this.tick(), CALL_WATCH_EVERY * 1000);
    signal?.addEventListener("abort", () => clearInterval(timer));
  }

  // The pushes started so far, done
  settled(): Promise<void> {
    return this.pushes;
  }

  // One look at a time: a look still waiting for the page skips the next ones
  async tick() {
    const page = this.a.tp?.page;
    if (this.busy || !page || page.isClosed() || !isTeamsUrl(page.url())) return;
    this.busy = true;
    try {
      const event = this.tracker.update(await page.evaluate(readIncomingCall, { s: SEL, t: TEXTS }));
      if (event?.kind === "ringing") {
        if (event.replaced) {
          this.logCall(event.replaced);
          this.ended();
        }
        if (!event.again) {
          log.info("call", "ringing", { caller: event.caller });
          this.keep({ caller: event.caller, since: event.since, seen: this.wall(), ringing: true });
        }
        this.push(event.caller, event.again ? "again" : "ringing", event.since);
      } else if (event) {
        log.info("call", "ended", { caller: event.caller, seconds: event.seconds });
        this.keep({ caller: event.caller, since: event.since, seen: this.wall(), ringing: false });
        this.logCall(event);
        this.push(event.caller, "ended", event.since, event.seconds);
        this.ended();
      }
      // still ringing: seen again, for the web app
      const now = this.tracker.current();
      if (now && event?.kind !== "ended" && this.clock() - this.written >= CALL_SEEN_EVERY * 1000) this.keep({ ...now, seen: this.wall(), ringing: true });
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

  private push(...args: Parameters<Agent["notifier"]["call"]>) {
    this.pushes = this.pushes
      .then(() => this.a.notifier.call(...args))
      .then(
        () => undefined,
        (e) => log.warn("call", `push: ${errorText(e)}`),
      );
  }

  private keep(call: CallState) {
    this.written = this.clock();
    this.save(() => this.a.store.setState(STATE.call, JSON.stringify(call)));
  }

  private logCall(c: EndedCall) {
    this.save(() => this.a.store.addCall(c.caller, c.since, c.seconds));
  }

  // A database that refuses a write (locked for longer than its wait) never holds up the push of the call
  private save(write: () => void) {
    try {
      write();
    } catch (e) {
      log.warn("call", `not saved: ${errorText(e)}`);
    }
  }
}
