// Mute of a call in progress in the app: Teams' own mute is the state of the call, the microphone of the device goes
// silent at once on a press and follows Teams afterwards, and stays silent when Teams could not be muted.
import { describe, expect, it } from "vitest";
import { CallMutes, type MuteView, shownMuted } from "@/lib/call-audio/mute";

function mutes() {
  const changes: [number, MuteView][] = [];
  const timers: (() => void)[] = [];
  const m = new CallMutes({ onChange: (acc, v) => changes.push([acc, v]), later: (fn) => void timers.push(fn) });
  return { m, changes, runTimers: () => timers.splice(0).forEach((fn) => fn()) };
}

describe("mute of a call in progress", () => {
  it("follows Teams' state from the event stream, the microphone of the device with it", () => {
    const { m, changes } = mutes();
    m.call(2, 100, false);
    expect(m.view(2)).toEqual({ teams: false, source: false, want: null });
    m.call(2, 100, true);
    expect(m.view(2)).toEqual({ teams: true, source: true, want: null });
    m.call(2, 100, false);
    expect(m.view(2)).toEqual({ teams: false, source: false, want: null });
    expect(changes.map(([acc]) => acc)).toEqual([2, 2, 2]);
  });

  it("silences the device at once on a press and shows it muted before Teams does", () => {
    const { m } = mutes();
    m.call(2, 100, false);
    m.press(2, true);
    expect(m.view(2)).toEqual({ teams: false, source: true, want: true });
    expect(shownMuted(m.view(2), true)).toBe(true);
    expect(shownMuted(m.view(2), false)).toBe(true);
  });

  it("takes the press as shown once Teams shows it, whether the stream or the command comes first", () => {
    const a = mutes();
    a.m.call(2, 100, false);
    a.m.press(2, true);
    a.m.call(2, 100, true);
    expect(a.m.view(2)).toEqual({ teams: true, source: true, want: null });
    a.m.settled(2, true);
    expect(a.m.view(2)).toEqual({ teams: true, source: true, want: null });
    const b = mutes();
    b.m.call(2, 100, false);
    b.m.press(2, true);
    b.m.settled(2, true);
    // done, the stream not there yet: still shown as asked, not as Teams was
    expect(b.m.view(2)).toEqual({ teams: false, source: true, want: true });
    b.m.call(2, 100, true);
    expect(b.m.view(2)).toEqual({ teams: true, source: true, want: null });
  });

  it("gives up waiting for the stream a while after the command was done, keeping the device as pressed", () => {
    const { m, runTimers } = mutes();
    m.call(2, 100, false);
    m.press(2, true);
    m.settled(2, true);
    runTimers();
    expect(m.view(2)).toEqual({ teams: false, source: true, want: null });
    expect(shownMuted(m.view(2), true)).toBe(true);
  });

  it("keeps the device silent when Teams could not be muted: muted here only", () => {
    const { m } = mutes();
    m.call(2, 100, false);
    m.press(2, true);
    m.settled(2, false);
    expect(m.view(2)).toEqual({ teams: false, source: true, want: null });
    expect(shownMuted(m.view(2), true)).toBe(true);
    // the same Teams state again changes nothing: the device stays silent
    m.call(2, 100, false);
    expect(m.view(2).source).toBe(true);
    // Teams changing afterwards (a press in the desktop) is followed again
    m.call(2, 100, true);
    m.call(2, 100, false);
    expect(m.view(2)).toEqual({ teams: false, source: false, want: null });
  });

  it("works on the device alone while Teams' state cannot be read", () => {
    const { m } = mutes();
    m.call(2, 100, undefined);
    m.press(2, true);
    m.settled(2, false);
    expect(m.view(2)).toEqual({ teams: undefined, source: true, want: null });
    m.call(2, 100, undefined);
    expect(m.view(2).source).toBe(true);
    m.press(2, false);
    m.settled(2, false);
    expect(m.view(2)).toEqual({ teams: undefined, source: false, want: null });
  });

  it("starts every new call of the account from Teams' state, nothing of the call before", () => {
    const { m } = mutes();
    m.call(2, 100, false);
    m.press(2, true);
    m.settled(2, false);
    m.call(2, 200, undefined);
    expect(m.view(2)).toEqual({ teams: undefined, source: false, want: null });
  });

  it("keeps the press when the stream still shows the state before it", () => {
    const { m } = mutes();
    m.call(2, 100, true);
    m.press(2, false);
    m.call(2, 100, true);
    expect(m.view(2)).toEqual({ teams: true, source: false, want: false });
    expect(shownMuted(m.view(2), true)).toBe(false);
  });

  it("shows muted from Teams alone where the sound is not in the app", () => {
    expect(shownMuted({ teams: false, source: true, want: null }, false)).toBe(false);
    expect(shownMuted({ teams: false, source: true, want: null }, true)).toBe(true);
    expect(shownMuted({ teams: true, source: false, want: null }, false)).toBe(true);
    expect(shownMuted({ source: false, want: null }, true)).toBe(false);
  });

  it("tells of nothing that did not change, and has a quiet view for an account it never saw", () => {
    const { m, changes } = mutes();
    expect(m.view(5)).toEqual({ source: false, want: null });
    m.call(2, 100, false);
    m.call(2, 100, false);
    m.settled(2, true);
    expect(changes).toHaveLength(1);
  });
});
