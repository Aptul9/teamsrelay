// Missed calls of an account always on: its browser ran while they rang, and the Activity feed read soon after a call
// tells which were missed (an answered call leaves none there). Each new one alerts once, as the check does for an
// account checked every N hours (commands/check.ts).
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "@/agent/context";
import { FEED_AFTER_CALL, FeedAfterCalls, pushMissedCalls } from "@/agent/jobs/missed-calls";
import type { Notifier } from "@/agent/push/notifier";
import { SlotStore, type ActivityEntry } from "@/agent/store/slot-store";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

let store: SlotStore;
let alerts: string[];

const agent = () => ({ store, notifier: { alert: async (title: string, body: string) => void alerts.push(`${title}: ${body}`) } as unknown as Notifier }) as unknown as Agent;

const mention = (id: string) => ({ id, kind: "mention", actor: "", title: "", emoji: "", preview: "", tm: "", chat: "", channel: false, unread: false, av: "" }) as ActivityEntry;
const missed = (id: string, caller: string, tm: string) =>
  ({ id, kind: "call", actor: caller, title: `Missed call from ${caller}`, emoji: "", preview: "Teams call", tm, chat: caller, channel: false, unread: false, av: "" }) as ActivityEntry;

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  alerts = [];
});

describe("missed calls of an account always on", () => {
  it("takes the missed calls of the first feed as known: an agent that starts pushes none of the past", async () => {
    store.saveActivity([missed("c1", "Anna Rossi", "9:02 AM"), mention("m1")]);
    expect(await pushMissedCalls(agent())).toBe(0);
    expect(alerts).toEqual([]);
  });

  it("alerts once for each missed call a later feed shows, with who called and when", async () => {
    store.saveActivity([mention("m1")]);
    await pushMissedCalls(agent());
    store.saveActivity([missed("c2", "Luca Bianchi", "10:05 AM"), missed("c1", "Anna Rossi", "9:02 AM"), mention("m1")]);
    expect(await pushMissedCalls(agent())).toBe(2);
    expect(alerts).toEqual(["Missed call from Luca Bianchi: Teams call at 10:05 AM, not answered", "Missed call from Anna Rossi: Teams call at 9:02 AM, not answered"]);
    expect(await pushMissedCalls(agent())).toBe(0);
    expect(alerts).toHaveLength(2);
  });

  it("does not alert again for a call a check already pushed, when the account was checked every N hours before", async () => {
    store.setState(STATE.checkSeen, JSON.stringify({ chats: [], activity: [], calls: ["c1"], read: true }));
    store.saveActivity([mention("m1")]);
    await pushMissedCalls(agent());
    store.saveActivity([missed("c1", "Anna Rossi", "9:02 AM"), mention("m1")]);
    expect(await pushMissedCalls(agent())).toBe(0);
  });

  it("names nobody when Teams shows no caller, and no time when it shows none", async () => {
    await pushMissedCalls(agent());
    store.saveActivity([missed("c3", "", "")]);
    await pushMissedCalls(agent());
    expect(alerts).toEqual(["Missed call: Teams call, not answered"]);
  });

  it("records what it alerts before the pushes: one that fails is not pushed again at the next read", async () => {
    await pushMissedCalls(agent());
    store.saveActivity([missed("c4", "Anna Rossi", "11:00 AM")]);
    const failing = {
      store,
      notifier: {
        alert: async () => {
          throw new Error("push service down");
        },
      },
    } as unknown as Agent;
    await expect(pushMissedCalls(failing)).resolves.toBe(1);
    expect(await pushMissedCalls(agent())).toBe(0);
  });
});

describe("feed read after a call", () => {
  it("is due a few seconds after a call ends, then once more later, and never before", () => {
    let now = 1_000_000;
    const f = new FeedAfterCalls(() => now);
    expect(f.due()).toBe(false);
    f.callEnded();
    expect(f.due()).toBe(false);
    now += FEED_AFTER_CALL[0] * 1000;
    expect(f.due()).toBe(true);
    f.ran();
    expect(f.due()).toBe(false);
    now += (FEED_AFTER_CALL[1] - FEED_AFTER_CALL[0]) * 1000;
    expect(f.due()).toBe(true);
    f.ran();
    now += 600_000;
    expect(f.due()).toBe(false);
  });

  it("covers a call that ends while the reads of an earlier one wait", () => {
    let now = 1_000_000;
    const f = new FeedAfterCalls(() => now);
    f.callEnded();
    now = 1_020_000;
    f.callEnded();
    now = 1_020_000 + FEED_AFTER_CALL[0] * 1000;
    expect(f.due()).toBe(true);
    f.ran();
    now = 1_020_000 + FEED_AFTER_CALL[1] * 1000;
    expect(f.due()).toBe(true);
  });
});
