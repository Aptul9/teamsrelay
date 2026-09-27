// An incoming call as the agent follows it: pushed at once, again every few seconds while it rings, and once more,
// quiet, when it stops. The watch looks on a timer of its own, whatever the loop is doing.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/agent/context";
import { CallWatch } from "@/agent/jobs/calls";
import { CALL_END_AFTER, CALL_RING_EVERY, CALL_RING_FOR, CallTracker } from "@/agent/logic/calls";

describe("call tracker", () => {
  let now = 1_790_000_000_000;
  const tracker = () => new CallTracker(() => now, () => now);
  const at = (t: CallTracker, seconds: number, caller: string | null) => {
    now = 1_790_000_000_000 + seconds * 1000;
    return t.update(caller === null ? null : { caller });
  };

  it("rings at once, then again every few seconds while the toast shows", () => {
    const t = tracker();
    expect(at(t, 0, "Anna Rossi")).toEqual({ kind: "ringing", caller: "Anna Rossi", since: 1_790_000_000_000, again: false });
    expect(at(t, 1, "Anna Rossi")).toBeNull();
    expect(at(t, CALL_RING_EVERY - 1, "Anna Rossi")).toBeNull();
    expect(at(t, CALL_RING_EVERY, "Anna Rossi")).toMatchObject({ kind: "ringing", again: true });
    expect(at(t, CALL_RING_EVERY + 1, "Anna Rossi")).toBeNull();
    expect(at(t, 2 * CALL_RING_EVERY, "Anna Rossi")).toMatchObject({ kind: "ringing", again: true });
  });

  it("stops ringing again after a minute: a toast left on the page does not ring for ever", () => {
    const t = tracker();
    at(t, 0, "Anna Rossi");
    for (let s = 1; s < CALL_RING_FOR; s++) at(t, s, "Anna Rossi");
    expect(CALL_RING_FOR).toBe(60);
    for (let s = CALL_RING_FOR; s < CALL_RING_FOR + 3 * CALL_RING_EVERY; s++) expect(at(t, s, "Anna Rossi")).toBeNull();
  });

  it("ends once the toast has been gone a moment, with how long it rang", () => {
    const t = tracker();
    at(t, 0, "Anna Rossi");
    at(t, 8, "Anna Rossi");
    expect(at(t, 9, null)).toBeNull();
    expect(at(t, 9 + CALL_END_AFTER - 1, null)).toBeNull();
    expect(at(t, 9 + CALL_END_AFTER, null)).toEqual({ kind: "ended", caller: "Anna Rossi", since: 1_790_000_000_000, seconds: 8 });
    expect(at(t, 20, null)).toBeNull();
  });

  it("does not end a call whose toast Teams draws again at once", () => {
    const t = tracker();
    at(t, 0, "Anna Rossi");
    expect(at(t, 1, null)).toBeNull();
    expect(at(t, 2, "Anna Rossi")).toBeNull();
    expect(at(t, 2 + CALL_END_AFTER, "Anna Rossi")).toBeNull();
  });

  it("rings for another caller as a new call, and for a caller it could not name", () => {
    const t = tracker();
    at(t, 0, "Anna Rossi");
    expect(at(t, 1, "Luca Bianchi")).toMatchObject({ kind: "ringing", caller: "Luca Bianchi", again: false });
    const u = tracker();
    expect(at(u, 0, "")).toMatchObject({ kind: "ringing", caller: "", again: false });
  });

  it("keeps one call when the name shows a moment after the toast, or goes for a moment, and ends it named", () => {
    const t = tracker();
    at(t, 0, "");
    expect(at(t, 1, "Anna Rossi")).toBeNull();
    expect(at(t, 2, "")).toBeNull();
    expect(at(t, CALL_RING_EVERY, "Anna Rossi")).toMatchObject({ kind: "ringing", caller: "Anna Rossi", again: true });
    at(t, 6, null);
    expect(at(t, 6 + CALL_END_AFTER, null)).toMatchObject({ kind: "ended", caller: "Anna Rossi", seconds: 5 });
  });

  it("times the ringing on a clock that only goes forward: the wall clock set back keeps no call ringing", () => {
    let mono = 0;
    let wall = 1_790_000_000_000;
    const t = new CallTracker(() => mono, () => wall);
    expect(t.update({ caller: "Anna Rossi" })).toMatchObject({ since: 1_790_000_000_000 });
    mono += 1000;
    wall -= 600_000;
    t.update(null);
    mono += CALL_END_AFTER * 1000;
    expect(t.update(null)).toEqual({ kind: "ended", caller: "Anna Rossi", since: 1_790_000_000_000, seconds: 0 });
  });

  it("has nothing to say without a call", () => {
    expect(at(tracker(), 0, null)).toBeNull();
  });
});

describe("call watch", () => {
  afterEach(() => vi.useRealTimers());

  // what the page shows at each look: a caller, no toast (null), or an error of the page (navigating)
  function watch(seen: (string | null | Error)[], url = "https://teams.microsoft.com/v2/") {
    const calls: unknown[][] = [];
    let looks = 0;
    const evaluate = vi.fn(async () => {
      const v = seen[Math.min(looks++, seen.length - 1)];
      if (v instanceof Error) throw v;
      return v === null ? null : { caller: v };
    });
    const a = {
      tp: { page: { evaluate, url: () => url, isClosed: () => false } },
      notifier: { call: vi.fn(async (...args: unknown[]) => void calls.push(args)) },
    } as unknown as Agent;
    let now = 1_790_000_000_000;
    const w = new CallWatch(a, () => now, () => now);
    return { w, calls, evaluate, tick: async (seconds = 1) => ((now += seconds * 1000), await w.tick()) };
  }

  it("pushes the call when it rings, again while it rings, and when it ends", async () => {
    const { calls, tick } = watch([...Array<string>(CALL_RING_EVERY + 1).fill("Anna Rossi"), null, null, null]);
    for (let i = 0; i < CALL_RING_EVERY + 4; i++) await tick();
    expect(calls).toEqual([
      ["Anna Rossi", "ringing", 1_790_000_001_000],
      ["Anna Rossi", "again", 1_790_000_001_000],
      ["Anna Rossi", "ended", 1_790_000_001_000, CALL_RING_EVERY],
    ]);
  });

  it("does not end a call on a page it could not read", async () => {
    const { calls, tick } = watch(["Anna Rossi", new Error("Execution context was destroyed"), new Error("Target closed"), new Error("x")]);
    for (let i = 0; i < 4; i++) await tick();
    expect(calls).toEqual([["Anna Rossi", "ringing", 1_790_000_001_000]]);
  });

  it("does not look outside Teams (sign-in pages)", async () => {
    const { calls, evaluate, tick } = watch(["Anna Rossi"], "https://login.microsoftonline.com/common/oauth2");
    await tick();
    expect(evaluate).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("looks every second on a timer of its own, one look at a time, until stopped", async () => {
    vi.useFakeTimers();
    const { w, evaluate } = watch(["Anna Rossi"]);
    let release = () => {};
    evaluate.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ caller: "Anna Rossi" }))));
    const stop = new AbortController();
    w.start(stop.signal);
    await vi.advanceTimersByTimeAsync(3000);
    // the first look hangs: the next ones wait for it
    expect(evaluate).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(evaluate).toHaveBeenCalledTimes(3);
    stop.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(evaluate).toHaveBeenCalledTimes(3);
  });
});
