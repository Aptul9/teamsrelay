// The Activity feed job of the loop and the refresh command: a read soon after a call ended, and the missed calls it
// shows first alerted, but for an account checked every N hours, whose check does that (commands/check.ts)
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activity } from "@/agent/commands/activity";
import type { Agent } from "@/agent/context";
import { readActivity } from "@/agent/jobs/activity";
import { FEED_AFTER_CALL, FeedAfterCalls } from "@/agent/jobs/missed-calls";
import { agentJobs } from "@/agent/loop";
import type { Notifier } from "@/agent/push/notifier";
import { Scheduler } from "@/agent/scheduler";
import { SlotStore, type ActivityEntry } from "@/agent/store/slot-store";
import { tempDir } from "../helpers";

// the read itself is tested with its page elsewhere: here it counts, and the feed is what the test saved
vi.mock("@/agent/jobs/activity", () => ({ readActivity: vi.fn(async () => 1) }));

let store: SlotStore;
let alerts: string[];

const missed = (id: string, caller: string) =>
  ({ id, kind: "call", actor: caller, title: `Missed call from ${caller}`, emoji: "", preview: "Teams call", tm: "10:05 AM", chat: caller, channel: false, unread: false, av: "" }) as ActivityEntry;

function agent(o: { checkedOnly?: boolean } = {}) {
  return {
    store,
    // the Teams page of the round, for the span of the agent's own input
    tp: { page: {} },
    config: { activity: true, readBy: false },
    health: { cdp: "ok", teams: "ok", overall: "green", ts: 1 },
    railReady: true,
    checkedOnly: () => !!o.checkedOnly,
    notifier: { alert: async (title: string, body: string) => void alerts.push(`${title}: ${body}`) } as unknown as Notifier,
  } as unknown as Agent;
}

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  alerts = [];
  vi.mocked(readActivity).mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

// the feed job of the loop alone, run round after round
function loop(a: Agent, afterCalls: FeedAfterCalls) {
  const s = new Scheduler(
    agentJobs(a, afterCalls).filter((j) => j.name === "activity"),
    () => {},
  );
  return async (n: number) => {
    for (let i = 0; i < n; i++) await s.runRound({ onTeams: true, want: "" });
  };
}

describe("feed of an account always on", () => {
  it("is read a few seconds after a call ends, out of its turn, and alerts the missed call it shows", async () => {
    const afterCalls = new FeedAfterCalls();
    const round = loop(agent(), afterCalls);
    await round(6);
    // the read after the start only records the missed calls it finds
    expect(readActivity).toHaveBeenCalledTimes(1);
    afterCalls.callEnded();
    store.saveActivity([missed("c1", "Anna Rossi")]);
    vi.advanceTimersByTime((FEED_AFTER_CALL[0] - 1) * 1000);
    await round(3);
    expect(readActivity).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    await round(1);
    expect(readActivity).toHaveBeenCalledTimes(2);
    expect(alerts).toEqual(["Missed call from Anna Rossi: Teams call at 10:05 AM, not answered"]);
    vi.advanceTimersByTime((FEED_AFTER_CALL[1] - FEED_AFTER_CALL[0]) * 1000);
    await round(1);
    expect(readActivity).toHaveBeenCalledTimes(3);
    expect(alerts).toHaveLength(1);
  });

  it("alerts nothing for an account checked every N hours: its check pushes its missed calls", async () => {
    const afterCalls = new FeedAfterCalls();
    const round = loop(agent({ checkedOnly: true }), afterCalls);
    await round(6);
    afterCalls.callEnded();
    store.saveActivity([missed("c1", "Anna Rossi")]);
    vi.advanceTimersByTime(FEED_AFTER_CALL[0] * 1000);
    await round(1);
    expect(readActivity).toHaveBeenCalledTimes(2);
    expect(alerts).toEqual([]);
  });

  it("alerts at a refresh the app asked for, not a turn of the loop later", async () => {
    const a = agent();
    await activity(a, { id: 1, type: "activity", arg1: "", arg2: "" });
    store.saveActivity([missed("c1", "Anna Rossi")]);
    expect(await activity(a, { id: 2, type: "activity", arg1: "", arg2: "" })).toBe("done");
    expect(alerts).toEqual(["Missed call from Anna Rossi: Teams call at 10:05 AM, not answered"]);
    vi.mocked(readActivity).mockResolvedValueOnce(null);
    expect(await activity(a, { id: 3, type: "activity", arg1: "", arg2: "" })).toBe("failed");
  });
});
