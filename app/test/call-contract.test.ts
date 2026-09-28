// What the web app and the agent agree on to answer and hang up a call: two command types the call watch runs, the
// call a command answers, and the call in progress as the slot database keeps it.
import { describe, expect, it } from "vitest";
import { AnswerArgs, CALL_COMMANDS, COMMAND_TYPES, parseArgs } from "@/shared/slot-db/commands";
import { CALL_FRESH_FOR, InCall, inCallOf, STATE } from "@/shared/slot-db/state";

describe("call commands", () => {
  it("come last, after every earlier type, which keeps its name", () => {
    expect(COMMAND_TYPES.slice(-2)).toEqual(["answer", "hangup"]);
    expect(COMMAND_TYPES.indexOf("check")).toBe(COMMAND_TYPES.length - 3);
    expect(CALL_COMMANDS).toEqual(["answer", "hangup"]);
  });

  it("answer names the call by when it started ringing; junk names none", () => {
    expect(parseArgs(AnswerArgs, '{"since":1790000000000}')).toEqual({ since: 1_790_000_000_000 });
    expect(parseArgs(AnswerArgs, '{"since":"soon"}')).toEqual({ since: 0 });
    expect(parseArgs(AnswerArgs, "not json")).toEqual({ since: 0 });
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
});
