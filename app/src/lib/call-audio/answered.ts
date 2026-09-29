// What the page needs of the sound of one call (CallAudio, or a fake in the tests)
export type CallSound = { start(): void; stop(): void; mute(on: boolean): void; resume(): void };

// An answer that never became a call in progress (refused, too late) gives the sound up after this long; a call in
// progress gives it up this long after it left the event stream, which drops for a few seconds when the web app
// restarts
const ANSWER_GRACE_MS = 30_000;
const CALL_OVER_GRACE_MS = 10_000;

// The sound of the calls answered in the app, by account. One at a time: it is the sound of the whole desktop.
export class AnsweredCalls<S extends CallSound = CallSound> {
  private calls = new Map<number, { sound: S; inProgress: boolean; timer?: ReturnType<typeof setTimeout> }>();

  constructor(private readonly o: { make: (acc: number) => S; onStop?: (acc: number) => void }) {}

  has(acc: number) {
    return this.calls.has(acc);
  }

  // the sound of the call of an account while it lasts
  get(acc: number): S | undefined {
    return this.calls.get(acc)?.sound;
  }

  start(acc: number) {
    if (this.calls.has(acc)) return;
    for (const other of [...this.calls.keys()]) this.stop(other);
    const sound = this.o.make(acc);
    this.calls.set(acc, { sound, inProgress: false, timer: setTimeout(() => this.stop(acc), ANSWER_GRACE_MS) });
    sound.start();
  }

  // the accounts with a call in progress, as the event stream lists them now
  inProgress(accs: number[]) {
    for (const [acc, c] of this.calls) {
      if (accs.includes(acc)) {
        c.inProgress = true;
        clearTimeout(c.timer);
        c.timer = undefined;
      } else if (c.inProgress && !c.timer) {
        c.timer = setTimeout(() => this.stop(acc), CALL_OVER_GRACE_MS);
      }
    }
  }

  mute(acc: number, on: boolean) {
    this.calls.get(acc)?.sound.mute(on);
  }

  resume(acc: number) {
    this.calls.get(acc)?.sound.resume();
  }

  stop(acc: number) {
    const c = this.calls.get(acc);
    if (!c) return;
    clearTimeout(c.timer);
    this.calls.delete(acc);
    c.sound.stop();
    this.o.onStop?.(acc);
  }

  stopAll() {
    for (const acc of [...this.calls.keys()]) this.stop(acc);
  }
}
