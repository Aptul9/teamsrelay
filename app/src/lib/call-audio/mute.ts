// Mute of a call in progress, per account. Teams' own mute is the state of the call, what the others see: the app shows
// it and follows it, whoever changed it (the app, Teams in the remote desktop, an organizer). The microphone of this
// device (source) goes silent at once on a press, before Teams mutes about a second later, stays silent when Teams could
// not be muted, and otherwise follows Teams' state as it changes. want: a press Teams does not show yet.
export type MuteView = { teams?: boolean; source: boolean; want: boolean | null };

// Whether the call shows as muted: the press on its way, else the microphone of this device (only while it carries the
// sound of the call) or Teams muted
export const shownMuted = (v: MuteView, sourceLive: boolean) => v.want ?? ((sourceLive && v.source) || v.teams === true);

// After the command of a press was done, how long the app waits for the event stream to show it before it lets the press go
const CONFIRM_FOR_MS = 5_000;

type Entry = MuteView & { since?: number; timer?: unknown };

export class CallMutes {
  private readonly calls = new Map<number, Entry>();
  private readonly told = new Map<number, string>();
  private readonly later: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (timer: unknown) => void;

  constructor(
    private readonly o: {
      onChange: (acc: number, v: MuteView) => void;
      later?: (fn: () => void, ms: number) => unknown;
      cancel?: (timer: unknown) => void;
    },
  ) {
    this.later = o.later ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = o.cancel ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  view(acc: number): MuteView {
    const e = this.calls.get(acc);
    return e ? { teams: e.teams, source: e.source, want: e.want } : { source: false, want: null };
  }

  // The call in progress of the account as the event stream shows it (since names the call) and Teams' mute state,
  // undefined while the agent cannot read it. A new call starts from Teams' state, nothing of the call before.
  call(acc: number, since: number, teams: boolean | undefined) {
    let e = this.calls.get(acc);
    if (!e || (e.since !== undefined && e.since !== since)) {
      if (e) this.stop(e);
      e = { since, teams, source: teams ?? false, want: null };
      this.calls.set(acc, e);
      return this.tell(acc);
    }
    e.since = since;
    const before = e.teams;
    e.teams = teams;
    if (e.want !== null) {
      if (teams === e.want) {
        e.want = null;
        this.stop(e);
      }
    } else if (teams !== undefined && teams !== before) e.source = teams;
    this.tell(acc);
  }

  // A press on the banner: the microphone of this device at once, the command to Teams sent by the caller
  press(acc: number, on: boolean) {
    let e = this.calls.get(acc);
    if (!e) {
      e = { source: false, want: null };
      this.calls.set(acc, e);
    }
    this.stop(e);
    e.source = on;
    e.want = on;
    this.tell(acc);
  }

  // The command of the last press ended: failed, Teams was not changed and the device keeps its microphone as pressed;
  // done, Teams shows it, and the event stream brings it within a second or two
  settled(acc: number, ok: boolean) {
    const e = this.calls.get(acc);
    if (!e || e.want === null) return;
    if (!ok || e.teams === e.want) {
      e.want = null;
      this.stop(e);
      return this.tell(acc);
    }
    const want = e.want;
    this.stop(e);
    e.timer = this.later(() => {
      if (this.calls.get(acc) !== e || e.want !== want) return;
      e.want = null;
      e.timer = undefined;
      this.tell(acc);
    }, CONFIRM_FOR_MS);
  }

  private stop(e: Entry) {
    if (e.timer !== undefined) this.cancel(e.timer);
    e.timer = undefined;
  }

  private tell(acc: number) {
    const v = this.view(acc);
    const key = JSON.stringify(v);
    if (this.told.get(acc) === key) return;
    this.told.set(acc, key);
    this.o.onChange(acc, v);
  }
}
