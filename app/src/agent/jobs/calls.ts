import type { Page } from "playwright-core";
import { AnswerArgs, MuteArgs, parseArgs } from "@/shared/slot-db/commands";
import { CALL_SEEN_EVERY, STATE, type CallState, type InCall } from "@/shared/slot-db/state";
import type { Agent } from "../context";
import { CallTracker, type EndedCall } from "../logic/calls";
import { isTeamsUrl } from "../logic/hosts";
import { errorText, log } from "../log";
import type { PendingCommand } from "../store/slot-store";
import { acceptCall, acceptShortcut, clickMic, hangUp, muteShortcut } from "../teams/call-actions";
import { micLive, micMuted, readIncomingCall } from "../teams/scripts/calls";
import { SEL, TEXTS } from "../teams/selectors";

// Seconds between two looks for a call
export const CALL_WATCH_EVERY = 1;
// An answer, a hang-up or a mute shows on the page within CONFIRM_TRIES looks CONFIRM_EVERY ms apart (5 s), or it failed
export const CONFIRM_TRIES = 20;
export const CONFIRM_EVERY = 250;
// looks after a click that did not take (the toast still there, no microphone) before the Accept shortcut (1.5 s)
const SHORTCUT_AFTER = 6;
// looks after the mute shortcut that changed nothing before the click on the microphone button (1.5 s)
export const MUTE_KEY_TRIES = 6;
// Seconds between two reads of the microphone of every frame while no call rings, was just answered here or is in
// progress: a call answered in the desktop shows in progress within that time
export const MIC_LOOK_EVERY = 5;
// Seconds a call answered here keeps the microphone read at every look, until Teams records
export const ANSWERED_WATCH = 60;

type Outcome = "done" | "failed";
type Watched = Pick<Agent, "notifier" | "store" | "inCall" | "ringing" | "callOverAt"> & { tp?: Agent["tp"]; config?: Pick<Agent["config"], "answerCalls"> };

// An incoming call, pushed as soon as its toast shows and followed until it stops (logic/calls.ts). Teams web rings
// a few seconds only, so the watch runs on a timer of its own, beside the loop: a round can take many seconds (the
// whole chat list, the Activity feed, a send). It only reads the page; a look that fails (the page navigating) says
// nothing about the call. The call is also kept in the slot database for the web app, which rings while it is open,
// and each call that ended goes to the call log of the account. The pushes of a call go out one after the other, in
// the background: a push service slow to answer (up to 15 s) holds up neither the looks nor the web app. ended: told
// of each call that ended, gone or replaced by another; the Activity feed read soon after says whether it was missed.
// Where calls are answered from the app (answerCalls), the watch also runs the answer, the hang-up and Teams' own mute
// the app asks for, at its next look, and keeps the call in progress for the web app while the page records from the
// microphone, with Teams' mute state as its microphone button shows it.
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
  // muted: Teams' own mute as last read, undefined while it cannot be read; held: told once that the call went on
  // muted without a microphone track
  private inCall: { caller: string; since: number; written: number; muted?: boolean; held?: boolean } | null = null;

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

  // The answers, hang-ups and mutes the app queued, oldest first. Never marked running: the loop ends every running
  // command as unconfirmed at each round, and one run again finds no toast, no call or the state asked already, and
  // presses nothing.
  private async runCallCommands(page: Page) {
    for (const cmd of this.a.store.pendingCommands()) {
      if (cmd.type !== "answer" && cmd.type !== "hangup" && cmd.type !== "mute") continue;
      log.info("CMD", cmd.type, { id: cmd.id, arg: cmd.arg1 || undefined });
      const outcome = cmd.type === "answer" ? await this.answer(page, cmd) : cmd.type === "hangup" ? await this.hangUp(page) : await this.setMute(page, cmd);
      this.a.store.finishCommand(cmd.id, outcome);
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

  // The shortcut of Teams web that ends a call, on the page that records from the microphone: done once it stops. A
  // call muted in Teams that let the microphone go gets it on the page of its microphone button: done once that goes.
  private async hangUp(page: Page): Promise<Outcome> {
    const recording = await this.recordingPage(page);
    const target = recording ?? (this.inCall ? ((await this.callMic(page))?.page ?? null) : null);
    if (!target) {
      log.warn("call", "hangup: no call in progress");
      return "failed";
    }
    await hangUp(target);
    for (let i = 0; i < CONFIRM_TRIES; i++) {
      if (recording ? !(await this.recordingPage(page)) : !(await this.callMic(page))) {
        log.info("call", "hung up");
        return "done";
      }
      await this.wait(CONFIRM_EVERY);
    }
    log.warn("call", recording ? "hangup: the microphone stayed on after the shortcut" : "hangup: the call stayed on screen after the shortcut");
    return "failed";
  }

  // Teams' own mute as the app asks for it (on). The shortcut toggles: the state is read first and the shortcut
  // pressed only when Teams shows the other one; done once the microphone button reads as asked. Where the shortcut
  // changed nothing in MUTE_KEY_TRIES looks, the state is read again, so that a shortcut taking late is not undone, and
  // the microphone button clicked once. Nothing is pressed on a state that cannot be read.
  private async setMute(page: Page, cmd: PendingCommand): Promise<Outcome> {
    const { on } = parseArgs(MuteArgs, cmd.arg2);
    if (on === null) {
      log.warn("call", "mute: no state asked for, nothing pressed");
      return "failed";
    }
    if (!this.inCall) {
      log.warn("call", "mute: no call in progress", { on });
      return "failed";
    }
    const mic = await this.callMic(page);
    if (!mic) {
      log.warn("call", "mute: Teams' microphone button cannot be read, nothing pressed", { on });
      return "failed";
    }
    if (mic.muted === on) return this.muteShown(on, "already");
    await muteShortcut(mic.page);
    if (await this.muteShows(page, on, MUTE_KEY_TRIES)) return this.muteShown(on, "shortcut");
    const again = await this.callMic(page);
    if (again?.muted === on) return this.muteShown(on, "shortcut");
    if (!again) {
      log.warn("call", "mute: Teams' microphone button cannot be read after the shortcut, nothing more pressed", { on });
      return "failed";
    }
    log.warn("call", "mute: the shortcut changed nothing, clicking the microphone button", { on });
    if (!(await clickMic(again.page))) {
      log.warn("call", "mute: no part of the microphone button to click", { on });
      return "failed";
    }
    if (await this.muteShows(page, on, CONFIRM_TRIES - MUTE_KEY_TRIES)) return this.muteShown(on, "click");
    log.warn("call", "mute: Teams' microphone button stayed as it was after the shortcut and the click", { on });
    return "failed";
  }

  // The microphone button reads on within tries looks CONFIRM_EVERY ms apart
  private async muteShows(page: Page, on: boolean, tries: number): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      await this.wait(CONFIRM_EVERY);
      if ((await this.callMic(page))?.muted === on) return true;
    }
    return false;
  }

  // The state asked for shows in Teams: the web app gets it at once
  private muteShown(on: boolean, by: "already" | "shortcut" | "click"): Outcome {
    log.info("call", on ? "muted in Teams" : "unmuted in Teams", { by });
    const c = this.inCall;
    if (c) {
      c.muted = on;
      c.written = this.clock();
      this.keepInCall({ caller: c.caller, since: c.since, seen: this.wall(), active: true, muted: on });
    }
    return "done";
  }

  // The Teams pages of the browser: the one the agent drives and the others (a call window of its own)
  private teamsPages(page: Page): Page[] {
    return page
      .context()
      .pages()
      .filter((p) => p === page || (!p.isClosed() && isTeamsUrl(p.url())));
  }

  // The Teams page of the browser that records from the microphone now, in any of its frames
  private async recordingPage(page: Page): Promise<Page | null> {
    for (const p of this.teamsPages(page)) {
      for (const frame of p.frames()) {
        if (await frame.evaluate(micLive).catch(() => false)) return p;
      }
    }
    return null;
  }

  // Teams' own mute of the call, from the microphone button on screen in any frame of any Teams page: the page that
  // shows it and whether it reads muted. Null where none shows one, or where two read differently.
  private async callMic(page: Page): Promise<{ page: Page; muted: boolean } | null> {
    let found: { page: Page; muted: boolean } | null = null;
    for (const p of this.teamsPages(page)) {
      for (const frame of p.frames()) {
        const muted = await frame.evaluate(micMuted, SEL).catch(() => null);
        if (muted === null) continue;
        if (found && found.muted !== muted) return null;
        found ??= { page: p, muted };
      }
    }
    return found;
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
  // as over when it stops; the loop moves Teams nowhere meanwhile (a.inCall). Teams' own mute goes with it, written at
  // once when it changes (a press in the desktop, an organizer). Teams may let the microphone go while muted: a call
  // in progress stays in progress while its microphone button reads muted; none starts from a button alone.
  private async watchMicrophone(page: Page) {
    const recording = !!(await this.recordingPage(page));
    const was = this.inCall;
    const mic = recording || was ? await this.callMic(page) : null;
    const live = recording || (!!was && mic?.muted === true);
    this.a.inCall = live;
    if (live) {
      const muted = mic?.muted;
      if (!was) log.info("call", "in progress", { caller: this.last?.caller || undefined, mute: muted === undefined ? "unreadable" : muted ? "on" : "off" });
      const c = was ?? { caller: this.last?.caller ?? "", since: this.last?.since ?? this.wall(), written: -Infinity, muted };
      this.inCall = c;
      if (!recording && !c.held) {
        c.held = true;
        log.info("call", "no microphone track while muted in Teams: the call stays in progress");
      }
      const changed = c.muted !== muted;
      if (changed) {
        if (muted === undefined) log.warn("call", "Teams' microphone button cannot be read");
        else log.info("call", muted ? "muted in Teams" : "unmuted in Teams");
      }
      c.muted = muted;
      if (!changed && this.clock() - c.written < CALL_SEEN_EVERY * 1000) return;
      c.written = this.clock();
      this.keepInCall({ caller: c.caller, since: c.since, seen: this.wall(), active: true, ...(muted === undefined ? {} : { muted }) });
    } else if (was) {
      this.inCall = null;
      this.a.callOverAt = this.wall();
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
