// An incoming call as the agent follows it: pushed at once, again every few seconds while it rings, and once more,
// quiet, when it stops. The watch looks on a timer of its own, whatever the loop is doing, and keeps the call in the
// slot database for the web app, which rings while it is open.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/agent/context";
import { CallWatch } from "@/agent/jobs/calls";
import { preparePage } from "@/agent/jobs/page-setup";
import { CALL_END_AFTER, CALL_RING_EVERY, CALL_RING_FOR, CallTracker } from "@/agent/logic/calls";
import * as callActions from "@/agent/teams/call-actions";
import { CALL_SEEN_EVERY, STATE } from "@/shared/slot-db/state";

vi.mock("@/agent/teams/call-actions", () => ({ acceptCall: vi.fn(), hangUp: vi.fn() }));

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

  it("names the call ringing now, until its toast goes or it has rung a minute", () => {
    const t = tracker();
    expect(t.current()).toBeNull();
    at(t, 0, "");
    expect(t.current()).toEqual({ caller: "", since: 1_790_000_000_000 });
    at(t, 1, "Anna Rossi");
    expect(t.current()).toEqual({ caller: "Anna Rossi", since: 1_790_000_000_000 });
    at(t, 2, null);
    expect(t.current()).toBeNull();
    at(t, 3, "Anna Rossi");
    expect(t.current()).toEqual({ caller: "Anna Rossi", since: 1_790_000_000_000 });
    at(t, CALL_RING_FOR, "Anna Rossi");
    expect(t.current()).toBeNull();
  });
});

describe("call watch", () => {
  afterEach(() => vi.useRealTimers());

  // what the page shows at each look: a caller, no toast (null), or an error of the page (navigating). saved: the
  // call as the slot database holds it; failWrites: a database that refuses every write (locked); ended: told of each
  // call that ended
  function watch(seen: (string | null | Error)[], url = "https://teams.microsoft.com/v2/", o: { failWrites?: boolean; ended?: () => void } = {}) {
    const calls: unknown[][] = [];
    const logged: unknown[][] = [];
    const states = new Map<string, string>();
    let looks = 0;
    const evaluate = vi.fn(async () => {
      const v = seen[Math.min(looks++, seen.length - 1)];
      if (v instanceof Error) throw v;
      return v === null ? null : { caller: v };
    });
    const a = {
      tp: { page: { evaluate, url: () => url, isClosed: () => false } },
      notifier: { call: vi.fn(async (...args: unknown[]) => void calls.push(args)) },
      store: {
        setState: vi.fn((k: string, v: string) => {
          if (o.failWrites) throw new Error("database is locked");
          states.set(k, v);
        }),
        addCall: vi.fn((...args: unknown[]) => {
          if (o.failWrites) throw new Error("database is locked");
          logged.push(args);
        }),
      },
    } as unknown as Agent;
    let now = 1_790_000_000_000;
    const w = new CallWatch(a, () => now, () => now, o.ended);
    const saved = () => JSON.parse(states.get(STATE.call) ?? "null");
    // a look, then the pushes it started, done
    const tick = async (seconds = 1) => {
      now += seconds * 1000;
      await w.tick();
      await w.settled();
    };
    return { w, a, calls, logged, evaluate, saved, tick, look: async () => ((now += 1000), await w.tick()) };
  }

  it("keeps looking, and seeing the call for the web app, while a push is slow; the pushes go out in order", async () => {
    const { w, a, calls, saved, look } = watch([...Array<string>(12).fill("Anna Rossi"), null, null, null]);
    let release = () => {};
    vi.mocked(a.notifier.call).mockImplementationOnce(async (...args: unknown[]) => {
      await new Promise<void>((r) => (release = r));
      calls.push(args);
      return 1;
    });
    await look();
    for (let i = 0; i < 11; i++) await look();
    // seen at 1 s, then every CALL_SEEN_EVERY (2) seconds: 11 s at the twelfth look
    expect(CALL_SEEN_EVERY).toBe(2);
    expect(saved().seen).toBe(1_790_000_011_000);
    expect(calls).toEqual([]);
    for (let i = 0; i < 3; i++) await look();
    release();
    await w.settled();
    expect(calls.map((c) => c[1])).toEqual(["ringing", "again", "again", "ended"]);
  });

  it("records in the call log a call that another caller's call replaced", async () => {
    const { logged, tick } = watch(["Anna Rossi", "Anna Rossi", "Luca Bianchi", null, null, null]);
    for (let i = 0; i < 6; i++) await tick();
    expect(logged).toEqual([
      ["Anna Rossi", 1_790_000_001_000, 1],
      ["Luca Bianchi", 1_790_000_003_000, 0],
    ]);
  });

  it("tells of each call that ended, gone or replaced by another: the Activity feed read then says whether it was missed", async () => {
    const ended = vi.fn();
    const { tick } = watch(["Anna Rossi", "Anna Rossi", "Luca Bianchi", null, null, null, null], undefined, { ended });
    for (let i = 0; i < 3; i++) await tick();
    expect(ended).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 4; i++) await tick();
    expect(ended).toHaveBeenCalledTimes(2);
  });

  it("records each call that ended in the call log of the account, with how long it rang", async () => {
    const { logged, tick } = watch(["Anna Rossi", "Anna Rossi", "Anna Rossi", null, null, null, "Luca Bianchi", null, null, null]);
    for (let i = 0; i < 10; i++) await tick();
    expect(logged).toEqual([
      ["Anna Rossi", 1_790_000_001_000, 2],
      ["Luca Bianchi", 1_790_000_007_000, 0],
    ]);
  });

  it("keeps the call in the slot database for the web app: at once, seen again every few seconds, not ringing once it ends", async () => {
    const { saved, tick } = watch([...Array<string>(6).fill("Anna Rossi"), null, null, null]);
    await tick();
    expect(saved()).toEqual({ caller: "Anna Rossi", since: 1_790_000_001_000, seen: 1_790_000_001_000, ringing: true });
    await tick();
    expect(saved().seen).toBe(1_790_000_001_000);
    await tick(CALL_SEEN_EVERY - 1);
    expect(saved().seen).toBe(1_790_000_001_000 + CALL_SEEN_EVERY * 1000);
    for (let i = 0; i < 6; i++) await tick();
    expect(saved()).toMatchObject({ caller: "Anna Rossi", since: 1_790_000_001_000, ringing: false });
  });

  it("stops seeing a call whose toast stays on the page after a minute, as the pushes stop", async () => {
    const { saved, tick } = watch(["Anna Rossi"]);
    for (let s = 0; s < CALL_RING_FOR + 10; s++) await tick();
    expect(saved().ringing).toBe(true);
    expect(saved().seen).toBeLessThanOrEqual(1_790_000_001_000 + CALL_RING_FOR * 1000);
  });

  it("pushes the call even when the slot database refuses to keep it", async () => {
    const { calls, tick } = watch(["Anna Rossi", "Anna Rossi", null, null, null], undefined, { failWrites: true });
    for (let i = 0; i < 5; i++) await tick();
    expect(calls).toEqual([
      ["Anna Rossi", "ringing", 1_790_000_001_000],
      ["Anna Rossi", "ended", 1_790_000_001_000, 1],
    ]);
  });

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

describe("answer and hang-up asked from the app", () => {
  beforeEach(() => {
    vi.mocked(callActions.acceptCall).mockReset();
    vi.mocked(callActions.hangUp).mockReset();
  });

  // The page shows the toast of the caller while toast.on and records from the microphone while mic.on; the store keeps
  // the commands queued (pending until finished) and the state rows. Waits of the watch move the clock on.
  function phone(o: { answerCalls?: boolean } = {}) {
    const toast = { on: false, caller: "Anna Rossi" };
    const mic = { on: false };
    const commands: { id: number; type: string; arg1: string; arg2: string; status: string }[] = [];
    const states = new Map<string, string>();
    const frame = { evaluate: vi.fn(async (fn: { name: string }) => (fn.name === "micLive" ? mic.on : null)) };
    const page = {
      url: () => "https://teams.microsoft.com/v2/",
      isClosed: () => false,
      evaluate: vi.fn(async (fn: { name: string }) => (fn.name === "readIncomingCall" && toast.on ? { caller: toast.caller } : null)),
      frames: () => [frame],
      context: () => ({ pages: () => [page] }),
    };
    const pushes: unknown[][] = [];
    const store = {
      setState: vi.fn((k: string, v: string) => void states.set(k, v)),
      addCall: vi.fn(),
      pendingCommands: vi.fn(() => commands.filter((c) => c.status === "pending").map(({ id, type, arg1, arg2 }) => ({ id, type, arg1, arg2 }))),
      finishCommand: vi.fn((id: number, status: string) => {
        const c = commands.find((x) => x.id === id);
        if (c) c.status = status;
      }),
    };
    const a = {
      config: { answerCalls: o.answerCalls ?? true },
      tp: { page },
      notifier: { call: vi.fn(async (...args: unknown[]) => void pushes.push(args)) },
      store,
    } as unknown as Agent;
    let now = 1_790_000_000_000;
    const w = new CallWatch(a, () => now, () => now, undefined, async (ms) => void (now += ms));
    const tick = async () => {
      now += 1000;
      await w.tick();
      await w.settled();
    };
    const queue = (type: string, arg2 = "") => {
      commands.push({ id: commands.length + 1, type, arg1: toast.caller, arg2, status: "pending" });
      return commands.length;
    };
    const status = (id: number) => commands.find((c) => c.id === id)?.status;
    const inCall = () => JSON.parse(states.get(STATE.inCall) ?? "null");
    const ringingSince = (): number => JSON.parse(states.get(STATE.call) ?? "null")?.since;
    return { a, toast, mic, page, frame, pushes, store, tick, queue, status, inCall, ringingSince };
  }

  it("answers the call ringing now: one real click on Accept, done once the toast is gone, never running on the way", async () => {
    const p = phone();
    p.toast.on = true;
    await p.tick();
    vi.mocked(callActions.acceptCall).mockImplementationOnce(async () => {
      p.toast.on = false;
      return true;
    });
    const id = p.queue("answer", JSON.stringify({ since: p.ringingSince() }));
    await p.tick();
    expect(callActions.acceptCall).toHaveBeenCalledTimes(1);
    expect(callActions.acceptCall).toHaveBeenCalledWith(p.page);
    expect(p.status(id)).toBe("done");
  });

  it("clicks nothing for another call, or once the call stopped ringing: failed", async () => {
    const p = phone();
    p.toast.on = true;
    await p.tick();
    const other = p.queue("answer", JSON.stringify({ since: p.ringingSince() - 60_000 }));
    await p.tick();
    p.toast.on = false;
    for (let i = 0; i < CALL_END_AFTER + 1; i++) await p.tick();
    const late = p.queue("answer", JSON.stringify({ since: p.ringingSince() }));
    await p.tick();
    expect([p.status(other), p.status(late)]).toEqual(["failed", "failed"]);
    expect(callActions.acceptCall).not.toHaveBeenCalled();
  });

  it("fails an answer whose click found no button, or whose toast stayed after the click", async () => {
    const p = phone();
    p.toast.on = true;
    await p.tick();
    const noButton = p.queue("answer", JSON.stringify({ since: p.ringingSince() }));
    await p.tick();
    vi.mocked(callActions.acceptCall).mockResolvedValueOnce(true);
    const stayed = p.queue("answer", JSON.stringify({ since: p.ringingSince() }));
    await p.tick();
    expect([p.status(noButton), p.status(stayed)]).toEqual(["failed", "failed"]);
  });

  it("ends the notification of a call answered here as answered, not as missed", async () => {
    const p = phone();
    p.toast.on = true;
    await p.tick();
    const since = p.ringingSince();
    vi.mocked(callActions.acceptCall).mockImplementationOnce(async () => {
      p.toast.on = false;
      return true;
    });
    p.queue("answer", JSON.stringify({ since }));
    for (let i = 0; i < CALL_END_AFTER + 2; i++) await p.tick();
    expect(p.pushes.at(-1)).toEqual(["Anna Rossi", "ended", since, expect.any(Number), true]);
  });

  it("keeps the call in progress for the web app while the page records, named after the call answered, and says when it is over", async () => {
    const p = phone();
    p.toast.on = true;
    await p.tick();
    const since = p.ringingSince();
    p.toast.on = false;
    p.mic.on = true;
    await p.tick();
    expect(p.inCall()).toMatchObject({ caller: "Anna Rossi", since, active: true });
    expect(p.a.inCall).toBe(true);
    p.mic.on = false;
    await p.tick();
    expect(p.inCall()).toMatchObject({ caller: "Anna Rossi", since, active: false });
    expect(p.a.inCall).toBe(false);
  });

  it("hangs up with the shortcut on the page that records, done once the microphone stops", async () => {
    const p = phone();
    p.mic.on = true;
    await p.tick();
    vi.mocked(callActions.hangUp).mockImplementationOnce(async () => void (p.mic.on = false));
    const id = p.queue("hangup");
    await p.tick();
    expect(callActions.hangUp).toHaveBeenCalledWith(p.page);
    expect(p.status(id)).toBe("done");
    expect(p.inCall()).toMatchObject({ active: false });
  });

  it("fails a hang-up with no call in progress without pressing anything, and one the microphone outlives", async () => {
    const p = phone();
    const none = p.queue("hangup");
    await p.tick();
    expect(p.status(none)).toBe("failed");
    expect(callActions.hangUp).not.toHaveBeenCalled();
    p.mic.on = true;
    const stays = p.queue("hangup");
    await p.tick();
    expect(p.status(stays)).toBe("failed");
  });

  it("answers nothing and follows no call in progress for a relay: its calls ring on its own computer", async () => {
    const p = phone({ answerCalls: false });
    p.toast.on = true;
    p.mic.on = true;
    await p.tick();
    p.queue("answer", JSON.stringify({ since: p.ringingSince() }));
    await p.tick();
    expect(p.store.pendingCommands).not.toHaveBeenCalled();
    expect(p.inCall()).toBeNull();
    expect(p.frame.evaluate).not.toHaveBeenCalled();
  });
});

describe("microphone hook of the pages", () => {
  function tab() {
    const added: string[] = [];
    const inFrames: string[] = [];
    const frame = {
      evaluate: vi.fn(async (fn: { name: string }) => {
        inFrames.push(fn.name);
        return "installed";
      }),
    };
    const context = { addInitScript: vi.fn(async (fn: { name: string }) => void added.push(fn.name)) };
    const page = { addInitScript: vi.fn(async () => undefined), evaluate: vi.fn(async () => "already"), context: () => context, frames: () => [frame, frame] };
    const agent = (answerCalls: boolean) => ({ config: { answerCalls }, tp: { page } }) as unknown as Agent;
    return { added, inFrames, agent };
  }

  it("goes into every page and frame of the browser, once for the pages to come, where calls are answered", async () => {
    const t = tab();
    await preparePage(t.agent(true));
    await preparePage(t.agent(true));
    expect(t.added).toEqual(["installMicHook"]);
    expect(t.inFrames).toEqual(Array(4).fill("installMicHook"));
  });

  it("stays out of the pages of a relay", async () => {
    const t = tab();
    await preparePage(t.agent(false));
    expect(t.added).toEqual([]);
    expect(t.inFrames).toEqual([]);
  });
});