// The automatic check of the loop (8-11 and 17-20) judges Teams once it had time to load: an agent started inside a
// window before its check ran (a restart, a deploy) pushed "Teams: problem" (Teams not fully loaded) for a Teams that
// was only starting. Teams still not ready after SELF_CHECK_GRACE is the problem the check reports.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/agent/context";
import { scheduledSelfCheck } from "@/agent/jobs/self-check";
import { agentJobs, SELF_CHECK_GRACE } from "@/agent/loop";
import { Scheduler } from "@/agent/scheduler";
import { SlotStore } from "@/agent/store/slot-store";
import { tempDir } from "../helpers";

// the check itself is tested with its page elsewhere: here it counts
vi.mock("@/agent/jobs/self-check", async (original) => ({ ...(await original<typeof import("@/agent/jobs/self-check")>()), scheduledSelfCheck: vi.fn(async () => {}) }));

let store: SlotStore;

function agent() {
  return {
    store,
    config: { activity: false, readBy: false },
    health: null,
    checkedOnly: () => false,
  } as unknown as Agent;
}

// the health the loop reads, with Teams in the state given
const health = (teams: "ok" | "login" | "loading") => ({ cdp: "ok", teams, overall: teams === "ok" ? "green" : "red", ts: 1 }) as Agent["health"];

// the check job of the loop alone, one round a call
function loop(a: Agent) {
  const s = new Scheduler(
    agentJobs(a).filter((j) => j.name === "self-check"),
    () => {},
  );
  return () => s.runRound({ onTeams: true, want: "" });
}

const at = (h: number, m = 0, s = 0) => vi.setSystemTime(new Date(2026, 8, 29, h, m, s));

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  vi.mocked(scheduledSelfCheck).mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("automatic check of the loop", () => {
  it("waits for Teams to load after a start inside its window, then checks once", async () => {
    const a = agent();
    const round = loop(a);
    at(9, 15);
    await round();
    a.health = health("loading");
    at(9, 15, 20);
    await round();
    expect(scheduledSelfCheck).not.toHaveBeenCalled();
    a.health = health("ok");
    at(9, 15, 40);
    await round();
    expect(scheduledSelfCheck).toHaveBeenCalledTimes(1);
  });

  it("checks a Teams still not ready after the grace, which is the problem to report", async () => {
    const a = agent();
    const round = loop(a);
    a.health = health("login");
    at(17, 0);
    await round();
    at(17, 0, SELF_CHECK_GRACE - 1);
    await round();
    expect(scheduledSelfCheck).not.toHaveBeenCalled();
    at(17, 0, SELF_CHECK_GRACE);
    await round();
    expect(scheduledSelfCheck).toHaveBeenCalledTimes(1);
  });

  it("counts the grace from the start of the window, not from a Teams not ready before it", async () => {
    const a = agent();
    const round = loop(a);
    a.health = health("loading");
    at(7, 50);
    await round();
    at(8, 0);
    await round();
    at(8, 0, SELF_CHECK_GRACE - 1);
    await round();
    expect(scheduledSelfCheck).not.toHaveBeenCalled();
    at(8, 0, SELF_CHECK_GRACE);
    await round();
    expect(scheduledSelfCheck).toHaveBeenCalledTimes(1);
  });
});
