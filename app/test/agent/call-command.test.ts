// Calling the person of a 1:1 chat from the app: the loop opens the chat in Teams and presses Teams' shortcut for an
// audio call, never while a call rings or is in progress, never in a chat that is not 1:1, never for a call asked too
// long ago; done once a Teams page records from the microphone, with the call watch told whom it calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL_MAX_AGE, CALL_START_WAIT, call } from "@/agent/commands/call";
import { nowSeconds, type Agent } from "@/agent/context";
import * as callActions from "@/agent/teams/call-actions";
import { cmdResultKey, STATE } from "@/shared/slot-db/state";

vi.mock("@/agent/teams/call-actions", () => ({ startAudioCall: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(callActions.startAudioCall).mockReset();
});

// The Teams page of the account: the chat list of the store (kind of each chat), a toast ringing or not, a header with
// the participants of a group or not, the page recording once the call is placed (records: at once, after that many ms,
// or never). open: what showChat answers (null: shown).
function teams(o: { kind?: string; group?: boolean; toast?: boolean; records?: boolean | number; open?: string | null; ringing?: boolean; inCall?: boolean; teams?: string } = {}) {
  const states = new Map<string, string>();
  let placedAt = -1;
  const recording = () => placedAt >= 0 && (o.records === true || (typeof o.records === "number" && Date.now() - placedAt >= o.records));
  const frame = { evaluate: vi.fn(async (fn: { name: string }) => (fn.name === "micLive" ? recording() : null)) };
  const page = {
    url: () => "https://teams.microsoft.com/v2/",
    isClosed: () => false,
    evaluate: vi.fn(async (fn: { name: string }) =>
      fn.name === "readIncomingCall" ? (o.toast ? { caller: "Luca Bianchi" } : null) : fn.name === "groupChatShown" ? !!o.group : fn.name === "openOverlayNames" ? [] : null,
    ),
    frames: () => [frame],
    context: () => ({ pages: () => [page] }),
  };
  const a = {
    health: { cdp: "ok", ts: 0, teams: o.teams ?? "ok", overall: "green" },
    ringing: o.ringing,
    inCall: o.inCall,
    tp: { page, showChat: vi.fn(async () => (o.open === undefined ? null : o.open)) },
    store: {
      chats: () => [
        { name: "Anna Rossi", kind: o.kind ?? "one" },
        { name: "MARITATO Antonio (You)", kind: "one" },
        { name: "Project Alpha", kind: "group" },
      ],
      setState: vi.fn((k: string, v: string) => void states.set(k, v)),
      getState: (k: string) => states.get(k) ?? "",
    },
  } as unknown as Agent;
  vi.mocked(callActions.startAudioCall).mockImplementation(async (_page, clear) => {
    if (!(await clear())) return false;
    placedAt = Date.now();
    return true;
  });
  const reason = (id: number) => JSON.parse(states.get(cmdResultKey(id)) ?? "null")?.reason;
  const cmd = (arg1 = "Anna Rossi", ts = nowSeconds()) => ({ id: 7, type: "call", arg1, arg2: "", ts });
  return { a, page, states, reason, cmd };
}

describe("call asked from the app", () => {
  it("opens the 1:1 chat, presses the call keys once and is done once the page records, the call watch told whom", async () => {
    const t = teams({ records: true });
    expect(await call(t.a, t.cmd())).toBe("done");
    expect(t.a.tp.showChat).toHaveBeenCalledWith("Anna Rossi");
    expect(callActions.startAudioCall).toHaveBeenCalledTimes(1);
    expect(t.a.outgoing).toEqual({ callee: "Anna Rossi", since: expect.any(Number) });
    expect(t.states.get(STATE.activeChat)).toBe("Anna Rossi");
    expect(JSON.parse(t.states.get(STATE.viewing) ?? "{}").chat).toBe("Anna Rossi");
  });

  it("waits for Teams to start recording, a moment after the keys", async () => {
    vi.useFakeTimers();
    const t = teams({ records: 1500 });
    const outcome = call(t.a, t.cmd());
    await vi.advanceTimersByTimeAsync(2000);
    await expect(outcome).resolves.toBe("done");
  });

  it("touches nothing while a call rings or is in progress", async () => {
    for (const o of [{ ringing: true }, { inCall: true }]) {
      const t = teams(o);
      expect(await call(t.a, t.cmd())).toBe("failed");
      expect(t.reason(7)).toBe("busy");
      expect(t.a.tp.showChat).not.toHaveBeenCalled();
    }
    expect(callActions.startAudioCall).not.toHaveBeenCalled();
  });

  it("calls only a 1:1 chat of the list, never the self chat", async () => {
    for (const [chat, kind] of [
      ["Project Alpha", "one"],
      ["Anna Rossi", "meeting"],
      ["Anna Rossi", ""],
      ["Nobody Here", "one"],
      ["MARITATO Antonio (You)", "one"],
    ]) {
      const t = teams({ kind });
      expect(await call(t.a, t.cmd(chat)), chat).toBe("failed");
      expect(t.reason(7)).toBe("not-one");
      expect(t.a.tp.showChat).not.toHaveBeenCalled();
    }
    expect(callActions.startAudioCall).not.toHaveBeenCalled();
  });

  it("presses nothing in a chat whose header shows its participants, though the list said 1:1", async () => {
    const t = teams({ group: true, records: true });
    expect(await call(t.a, t.cmd())).toBe("failed");
    expect(t.reason(7)).toBe("not-one");
    expect(callActions.startAudioCall).not.toHaveBeenCalled();
    expect(t.a.outgoing).toBeUndefined();
  });

  it("touches nothing while Teams is signed out, and says why Teams did not show the chat", async () => {
    const out = teams({ teams: "login" });
    expect(await call(out.a, out.cmd())).toBe("failed");
    expect(out.reason(7)).toBe("signed-out");
    expect(out.a.tp.showChat).not.toHaveBeenCalled();
    for (const why of ["not-listed", "not-shown"]) {
      const t = teams({ open: why });
      expect(await call(t.a, t.cmd())).toBe("failed");
      expect(t.reason(7)).toBe(why);
    }
    expect(callActions.startAudioCall).not.toHaveBeenCalled();
  });

  // the same keys accept a call ringing as a video call
  it("presses nothing when a call rings right before the keys", async () => {
    const t = teams({ toast: true, records: true });
    expect(await call(t.a, t.cmd())).toBe("failed");
    expect(t.reason(7)).toBe("busy");
    expect(t.a.outgoing).toBeUndefined();
  });

  it("fails when Teams does not start the call within the wait, and forgets whom it called", async () => {
    vi.useFakeTimers();
    const t = teams({ records: false });
    const outcome = call(t.a, t.cmd());
    await vi.advanceTimersByTimeAsync(CALL_START_WAIT + 1000);
    await expect(outcome).resolves.toBe("failed");
    expect(t.reason(7)).toBe("no-call");
    expect(t.a.outgoing).toBeUndefined();
  });

  // the app gives up on it: a call placed later would ring someone the owner no longer expects
  it("never places a call asked too long ago", async () => {
    const t = teams({ records: true });
    expect(await call(t.a, t.cmd("Anna Rossi", nowSeconds() - CALL_MAX_AGE))).toBe("failed");
    expect(t.reason(7)).toBe("late");
    expect(t.a.tp.showChat).not.toHaveBeenCalled();
    expect(await call(t.a, t.cmd("Anna Rossi", nowSeconds() - CALL_MAX_AGE + 2))).toBe("done");
  });
});
