// The sound of the calls answered in the app, kept by account: one at a time (it is the sound of the whole desktop),
// given up when the answer never became a call in progress, and a little after the call left the event stream.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnsweredCalls } from "@/lib/call-audio/answered";

type Fake = { n: number; started: number; stopped: number; muted: boolean[]; resumed: number };

let made: Fake[];
let gone: number[];
let calls: AnsweredCalls;

beforeEach(() => {
  vi.useFakeTimers();
  made = [];
  gone = [];
  calls = new AnsweredCalls({
    make: (n) => {
      const f: Fake = { n, started: 0, stopped: 0, muted: [], resumed: 0 };
      made.push(f);
      return { start: () => void f.started++, stop: () => void f.stopped++, mute: (on) => void f.muted.push(on), resume: () => void f.resumed++ };
    },
    onStop: (n) => gone.push(n),
  });
});

afterEach(() => {
  calls.stopAll();
  vi.useRealTimers();
});

describe("AnsweredCalls", () => {
  it("starts the sound of an account once, and stops the one of another account first", () => {
    calls.start(2);
    calls.start(2);
    expect(made.map((f) => [f.n, f.started])).toEqual([[2, 1]]);
    calls.start(3);
    expect(made[0].stopped).toBe(1);
    expect(gone).toEqual([2]);
    expect(calls.has(2)).toBe(false);
    expect(calls.has(3)).toBe(true);
  });

  it("gives the sound up when the answer never became a call in progress within 30 s", () => {
    calls.start(2);
    vi.advanceTimersByTime(29_999);
    expect(made[0].stopped).toBe(0);
    vi.advanceTimersByTime(1);
    expect(made[0].stopped).toBe(1);
    expect(gone).toEqual([2]);
  });

  it("keeps the sound while the call is in progress, and stops it 10 s after the call left the stream", () => {
    calls.start(2);
    vi.advanceTimersByTime(5_000);
    calls.inProgress([2]);
    vi.advanceTimersByTime(60_000);
    expect(made[0].stopped).toBe(0);
    calls.inProgress([]);
    vi.advanceTimersByTime(9_999);
    expect(made[0].stopped).toBe(0);
    vi.advanceTimersByTime(1);
    expect(made[0].stopped).toBe(1);
  });

  it("keeps the sound when the call comes back to the stream in time (the stream dropped for a moment)", () => {
    calls.start(2);
    calls.inProgress([2]);
    calls.inProgress([]);
    vi.advanceTimersByTime(6_000);
    calls.inProgress([2]);
    vi.advanceTimersByTime(60_000);
    expect(made[0].stopped).toBe(0);
  });

  it("passes Mute and a tap on", () => {
    calls.start(2);
    calls.mute(2, true);
    calls.resume(2);
    calls.mute(3, true);
    expect(made[0].muted).toEqual([true]);
    expect(made[0].resumed).toBe(1);
  });

  it("stops on demand, and all of them at the end", () => {
    calls.start(2);
    calls.stop(2);
    calls.stop(2);
    expect(made[0].stopped).toBe(1);
    calls.start(3);
    calls.stopAll();
    expect(made[1].stopped).toBe(1);
    expect(gone).toEqual([2, 3]);
  });
});
