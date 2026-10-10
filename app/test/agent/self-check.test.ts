// The automatic check of the day (8-11 and 17-20) pushes only a problem: a check that passes is logged and marked done
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/agent/context";
import { readChats } from "@/agent/jobs/chat-list";
import { updateHealth } from "@/agent/jobs/health";
import { scheduledSelfCheck } from "@/agent/jobs/self-check";
import { SlotStore } from "@/agent/store/slot-store";
import { tempDir } from "../helpers";

vi.mock("@/agent/jobs/health", () => ({ updateHealth: vi.fn() }));
vi.mock("@/agent/jobs/chat-list", () => ({ readChats: vi.fn() }));

let store: SlotStore;
let alerts: Array<[string, string, string | undefined]>;

function agent() {
  return {
    store,
    notifier: {
      alert: async (title: string, body: string, urgency?: string) => {
        alerts.push([title, body, urgency]);
        return 1;
      },
    },
  } as unknown as Agent;
}

const at = (h: number, m = 0) => vi.setSystemTime(new Date(2026, 8, 29, h, m));

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  alerts = [];
  vi.mocked(updateHealth).mockReset();
  vi.mocked(readChats).mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("scheduledSelfCheck", () => {
  it("pushes nothing when Teams works, marks the window done and does not check it again", async () => {
    vi.mocked(updateHealth).mockResolvedValue({ teams: "ok" } as never);
    vi.mocked(readChats).mockResolvedValue(true as never);
    at(9, 15);

    await scheduledSelfCheck(agent());
    await scheduledSelfCheck(agent());

    expect(alerts).toEqual([]);
    expect(store.getState("hc_20260929_am")).toBe("1");
    expect(readChats).toHaveBeenCalledTimes(1);
  });

  it("pushes a problem with its reason as a high alert and marks the window done", async () => {
    vi.mocked(updateHealth).mockResolvedValue({ teams: "login" } as never);
    at(17, 5);

    await scheduledSelfCheck(agent());

    expect(alerts).toEqual([["Teams: problem", "Teams signed out: sign in again", "high"]]);
    expect(store.getState("hc_20260929_pm")).toBe("1");
  });

  it("pushes the problem of a chat list that cannot be read", async () => {
    vi.mocked(updateHealth).mockResolvedValue({ teams: "ok" } as never);
    vi.mocked(readChats).mockResolvedValue(false as never);
    at(8, 0);

    await scheduledSelfCheck(agent());

    expect(alerts).toEqual([["Teams: problem", "Chat list not readable", "high"]]);
  });

  it("does nothing outside the two windows", async () => {
    at(13, 0);

    await scheduledSelfCheck(agent());

    expect(updateHealth).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);
  });
});
