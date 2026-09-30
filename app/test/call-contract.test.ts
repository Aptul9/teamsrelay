// What the web app and the agent agree on to answer, hang up and mute a call: three command types the call watch runs,
// the call a command answers, the mute state a command asks for, and the call in progress as the slot database keeps it.
import { describe, expect, it } from "vitest";
import { AnswerArgs, CALL_COMMANDS, CALL_REASONS, CallResult, COMMAND_TYPES, MuteArgs, parseArgs } from "@/shared/slot-db/commands";
import { CALL_FRESH_FOR, InCall, inCallOf, STATE } from "@/shared/slot-db/state";

describe("call commands", () => {
  it("come last, after every earlier type, which keeps its name", () => {
    expect(COMMAND_TYPES.slice(-4)).toEqual(["answer", "hangup", "mute", "call"]);
    expect(COMMAND_TYPES.indexOf("check")).toBe(COMMAND_TYPES.length - 5);
    // a call placed from the app opens its chat: the loop runs it, not the call watch
    expect(CALL_COMMANDS).toEqual(["answer", "hangup", "mute"]);
  });

  it("a call not placed says why in its result; anything else reads as no reason", () => {
    expect(CALL_REASONS).toEqual(["late", "busy", "signed-out", "not-listed", "not-shown", "not-one", "no-call"]);
    for (const reason of CALL_REASONS) expect(CallResult.safeParse({ reason }).success, reason).toBe(true);
    expect(CallResult.safeParse({ reason: "unreadable" }).success).toBe(false);
  });

  it("answer names the call by when it started ringing; junk names none", () => {
    expect(parseArgs(AnswerArgs, '{"since":1790000000000}')).toEqual({ since: 1_790_000_000_000 });
    expect(parseArgs(AnswerArgs, '{"since":"soon"}')).toEqual({ since: 0 });
    expect(parseArgs(AnswerArgs, "not json")).toEqual({ since: 0 });
  });

  // a state, never a toggle: Teams' shortcut toggles, the agent presses it only when Teams shows the other state
  it("mute asks for a state, muted or not; junk asks for none, never for unmuted", () => {
    expect(parseArgs(MuteArgs, '{"on":true}')).toEqual({ on: true });
    expect(parseArgs(MuteArgs, '{"on":false}')).toEqual({ on: false });
    for (const junk of ['{"on":"yes"}', '{"on":1}', "{}", "not json", ""]) expect(parseArgs(MuteArgs, junk), junk).toEqual({ on: null });
  });
});

describe("call in progress", () => {
  const now = 1_790_000_100_000;
  const row = (o: Partial<InCall>) => InCall.parse({ caller: "Anna Rossi", since: 1_790_000_000_000, seen: now - 1000, active: true, ...o });

  it("has a state row of its own, apart from the call that rings", () => {
    expect(STATE.inCall).toBe("in_call");
    expect(STATE.inCall).not.toBe(STATE.call);
  });

  it("is the call the agent saw in progress a moment ago", () => {
    expect(inCallOf(row({}), now)).toEqual({ caller: "Anna Rossi", since: 1_790_000_000_000 });
    expect(inCallOf(row({ seen: now - CALL_FRESH_FOR * 1000 }), now)).not.toBeNull();
  });

  it("is over once the agent says so, or when the agent stopped writing it", () => {
    expect(inCallOf(row({ active: false }), now)).toBeNull();
    expect(inCallOf(row({ seen: now - CALL_FRESH_FOR * 1000 - 1 }), now)).toBeNull();
    expect(inCallOf(null, now)).toBeNull();
  });

  it("reads a row with missing or wrong fields as no call", () => {
    expect(inCallOf(InCall.parse({}), now)).toBeNull();
    expect(inCallOf(InCall.parse({ active: "yes", seen: now }), now)).toBeNull();
  });

  it("carries Teams' own mute state while the agent can read it, nothing about it otherwise", () => {
    expect(inCallOf(row({ muted: true }), now)).toEqual({ caller: "Anna Rossi", since: 1_790_000_000_000, muted: true });
    expect(inCallOf(row({ muted: false }), now)).toEqual({ caller: "Anna Rossi", since: 1_790_000_000_000, muted: false });
    expect(inCallOf(row({}), now)).not.toHaveProperty("muted");
    expect(inCallOf(InCall.parse({ caller: "Anna Rossi", since: 1, seen: now, active: true, muted: "yes" }), now)).not.toHaveProperty("muted");
  });
});
