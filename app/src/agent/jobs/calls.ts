import type { Page } from "playwright-core";
import { AnswerArgs, parseArgs } from "@/shared/slot-db/commands";
import { CALL_SEEN_EVERY, STATE, type CallState, type InCall } from "@/shared/slot-db/state";
import type { Agent } from "../context";
import { CallTracker, type EndedCall } from "../logic/calls";
import { isTeamsUrl } from "../logic/hosts";
import { errorText, log } from "../log";
import type { PendingCommand } from "../store/slot-store";
import { acceptCall, acceptShortcut, hangUp } from "../teams/call-actions";
import { micLive, readIncomingCall } from "../teams/scripts/calls";
import { SEL, TEXTS } from "../teams/selectors";

// Seconds between two looks for a call
export const CALL_WATCH_EVERY = 1;
// An answer or a hang-up shows on the page within CONFIRM_TRIES looks CONFIRM_EVERY ms apart (5 s), or it failed
export const CONFIRM_TRIES = 20;
export const CONFIRM_EVERY = 250;
// looks after a click that did not take (the toast still there, no microphone) before the Accept shortcut (1.5 s)
const SHORTCUT_AFTER = 6;
// Seconds between two reads of the microphone of every frame while no call rings, was just answered here or is in
// progress: a call answered in the desktop shows in progress within that time
export const MIC_LOOK_EVERY = 5;
// Seconds a call answered here keeps the microphone read at every look, until Teams records
export const ANSWERED_WATCH = 60;

type Outcome = "done" | "failed";
type Watched = Pick<Agent, "notifier" | "store" | "inCall" | "ringing"> & { tp?: Agent["tp"]; config?: Pick<Agent["config"], "answerCalls"> };

// An incoming call, pushed as soon as its toast shows and followed until it stops (logic/calls.ts). Teams web rings
// a few seconds only, so the watch runs on a timer of its own, beside the loop: a round can take many seconds (the
// whole chat list, the Activity feed, a send). It only reads the page; a look that fails (the page navigating) says
// nothing about the call. The call is also kept in the slot database for the web app, which rings while it is open,
// and each call that ended goes to the call log of the account. The pushes of a call go out one after the other, in
// the background: a push service slow to answer (up to 15 s) holds up neither the looks nor the web app. ended: told
// of each call that ended, gone or replaced by another; the Activity feed read soon after says whether it was missed.
// Where calls are answered from the app (answerCalls), the watch also runs the answer and the hang-up the app asks
// for, at its next look, and keeps the call in progress for the web app while the page records from the microphone.
export class CallWatch {
  private readonly tracker: CallTracker;
  private busy = false;
  private warned = 0;
  private written = 0;
  private pushes: Promise<void> = Promise.resolve();
  // the call last seen ringing, which a call in progress is named after; answered: since of the call answered here
  private last: { caller: string; since: number } | null = null;
  private answered = 0;
  private answeredAt = -Infinity;
  private micLooked = -Infinity;
  private inCall: { caller: string; since: number; written: number } | null = null;

  constructor(
    private readonly a: Watched,
    private readonly clock: () => number = () => performance.now(),
    private readonly wall: () => number = Date.now,
    private readonly ended: () => void = () => {},
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
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
      await this.lookAtToast(page);
      if (this.a.config?.answerCalls) {
        await this.runCallCommands(page);
        if (this.microphoneDue()) await this.watchMicrophone(page);
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

  private async lookAtToast(page: Page) {
    const event = this.tracker.update(await this.readToast(page));
    // the loop keeps off the page while a call rings: an answer clicks there
    this.a.ringing = !!this.tracker.current();
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
      const answered = event.since === this.answered;
      log.info("call", "ended", { caller: event.caller, seconds: event.seconds, answered: answered || undefined });
      this.keep({ caller: event.caller, since: event.since, seen: this.wall(), ringing: false });
      this.logCall(event);
      if (answered) this.push(event.caller, "ended", event.since, event.seconds, true);
      else this.push(event.caller, "ended", event.since, event.seconds);
      this.ended();
    }
    // still ringing: seen again, for the web app
    const now = this.tracker.current();
    if (now) this.last = now;
    if (now && event?.kind !== "ended" && this.clock() - this.written >= CALL_SEEN_EVERY * 1000) this.keep({ ...now, seen: this.wall(), ringing: true });
  }

  private readToast(page: Page) {
    return page.evaluate(readIncomingCall, { s: SEL, t: TEXTS });
  }

  // The answers and hang-ups the app queued, oldest first. Never marked running: the loop ends every running command
  // as unconfirmed at each round, and one run again finds no toast or no call and fails without touching Teams.
  private async runCallCommands(page: Page) {
    for (const cmd of this.a.store.pendingCommands()) {
      if (cmd.type !== "answer" && cmd.type !== "hangup") continue;
      log.info("CMD", cmd.type, { id: cmd.id, arg: cmd.arg1 || undefined });
      this.a.store.finishCommand(cmd.id, cmd.type === "answer" ? await this.answer(page, cmd) : await this.hangUp(page));
    }
  }

  // Only the call of that since, only while its toast shows: a real click on Accept with audio, and the Accept shortcut
  // of Teams web where no part of the button can be clicked, or where the toast stays SHORTCUT_AFTER looks after the
  // click. Answered once the toast is gone or a page records from the microphone, whichever comes first.
  private async answer(page: Page, cmd: PendingCommand): Promise<Outcome> {
    const { since } = parseArgs(AnswerArgs, cmd.arg2);
    const ringing = this.tracker.current();
    if (!ringing || !since || ringing.since !== since) {
      log.warn("call", "answer: that call no longer rings", { since });
      return "failed";
    }
    let shortcut = !(await acceptCall(page));
    if (shortcut) {
      log.warn("call", "answer: no part of Accept to click, pressing the shortcut", { caller: ringing.caller });
      await acceptShortcut(page);
    }
    for (let i = 0; i < CONFIRM_TRIES; i++) {
      if (!(await this.readToast(page)) || (await this.recordingPage(page))) {
        this.answered = since;
        this.answeredAt = this.clock();
        log.info("call", "answered", { caller: ringing.caller, by: shortcut ? "shortcut" : "click" });
        return "done";
      }
      if (!shortcut && i + 1 === SHORTCUT_AFTER) {
        log.warn("call", "answer: the toast stayed after the click, pressing the shortcut", { caller: ringing.caller });
        await acceptShortcut(page);
        shortcut = true;
      }
      await this.wait(CONFIRM_EVERY);
    }
    log.warn("call", "answer: the call still rings after the click and the shortcut", { caller: ringing.caller });
    return "failed";
  }

  // The shortcut of Teams web that ends a call, on the page that records from the microphone
  private async hangUp(page: Page): Promise<Outcome> {
    const recording = await this.recordingPage(page);
    if (!recording) {
      log.warn("call", "hangup: no call in progress");
      return "failed";
    }
    await hangUp(recording);
    for (let i = 0; i < CONFIRM_TRIES; i++) {
      if (!(await this.recordingPage(page))) {
        log.info("call", "hung up");
        return "done";
      }
      await this.wait(CONFIRM_EVERY);
    }
    log.warn("call", "hangup: the microphone stayed on after the shortcut");
    return "failed";
  }

  // The Teams page of the browser that records from the microphone now, in any of its frames: a call window of its
  // own included
  private async recordingPage(page: Page): Promise<Page | null> {
    const pages = page
      .context()
      .pages()
      .filter((p) => p === page || (!p.isClosed() && isTeamsUrl(p.url())));
    for (const p of pages) {
      for (const frame of p.frames()) {
        if (await frame.evaluate(micLive).catch(() => false)) return p;
      }
    }
    return null;
  }

  // Every frame of every Teams page is read at every look while a call rings, was just answered here or is in progress;
  // otherwise every MIC_LOOK_EVERY seconds
  private microphoneDue(): boolean {
    const now = this.clock();
    const watching = !!this.inCall || !!this.tracker.current() || now - this.answeredAt < ANSWERED_WATCH * 1000;
    if (!watching && now - this.micLooked < MIC_LOOK_EVERY * 1000) return false;
    this.micLooked = now;
    return true;
  }

  // The call in progress for the web app: seen again every CALL_SEEN_EVERY seconds while the page records, once more
  // as over when it stops; the loop moves Teams nowhere meanwhile (a.inCall)
  private async watchMicrophone(page: Page) {
    const live = !!(await this.recordingPage(page));
    const was = this.inCall;
    this.a.inCall = live;
    if (live) {
      if (!was) log.info("call", "in progress", { caller: this.last?.caller || undefined });
      const c = was ?? { caller: this.last?.caller ?? "", since: this.last?.since ?? this.wall(), written: -Infinity };
      this.inCall = c;
      if (this.clock() - c.written < CALL_SEEN_EVERY * 1000) return;
      c.written = this.clock();
      this.keepInCall({ caller: c.caller, since: c.since, seen: this.wall(), active: true });
    } else if (was) {
      this.inCall = null;
      log.info("call", "over", { caller: was.caller || undefined });
      this.keepInCall({ caller: was.caller, since: was.since, seen: this.wall(), active: false });
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

  private keepInCall(call: InCall) {
    this.save(() => this.a.store.setState(STATE.inCall, JSON.stringify(call)));
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
