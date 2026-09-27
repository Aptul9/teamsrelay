import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { check } from "@/agent/commands/check";
import type { Agent } from "@/agent/context";
import { readActivity } from "@/agent/jobs/activity";
import { scanChatsFull } from "@/agent/jobs/chat-list";
import type { Notifier } from "@/agent/push/notifier";
import { SlotStore, type ActivityEntry } from "@/agent/store/slot-store";
import { tempDir } from "../helpers";

// The reads themselves are the jobs of the loop, tested with their pages elsewhere: here they only report how they went
vi.mock("@/agent/jobs/chat-list", () => ({ scanChatsFull: vi.fn(async () => 3) }));
vi.mock("@/agent/jobs/activity", () => ({ readActivity: vi.fn(async () => 1) }));

let store: SlotStore;
let alerts: string[];
let missed: string[][];

const agent = () =>
  ({
    store,
    notifier: {
      alert: async (title: string, body: string) => void alerts.push(`${title}: ${body}`),
      missedCall: async (caller: string, time: string) => void missed.push([caller, time]),
    } as unknown as Notifier,
  }) as unknown as Agent;
const cmd = { id: 1, type: "check", arg1: "", arg2: "" };

function chats(list: [string, string, boolean][]) {
  store.saveChats(
    list.map(([name, preview, unread]) => ({ name, preview, time: "10:02 AM", unread, mention: false, muted: false, av: "" })),
    true,
  );
}

function feed(ids: [string, boolean][]) {
  store.saveActivity(ids.map(([id, unread]) => ({ id, kind: "mention", actor: "", title: "", emoji: "", preview: "", tm: "", chat: "", channel: false, unread, av: "" }) as ActivityEntry));
}

// the feed with missed calls: [id, unread] for a mention, [id, unread, caller, time] for a missed call
function feedWithCalls(items: ([string, boolean] | [string, boolean, string, string])[]) {
  store.saveActivity(
    items.map(([id, unread, caller, tm]) =>
      caller === undefined
        ? ({ id, kind: "mention", actor: "", title: "", emoji: "", preview: "", tm: "", chat: "", channel: false, unread, av: "" } as ActivityEntry)
        : ({ id, kind: "call", actor: caller, title: `Missed call from ${caller}`, emoji: "", preview: "Teams call", tm, chat: caller, channel: false, unread, av: "" } as ActivityEntry),
    ),
  );
}

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  alerts = [];
  missed = [];
  vi.mocked(scanChatsFull).mockResolvedValue(3);
  vi.mocked(readActivity).mockResolvedValue(1);
});

describe("check command", () => {
  it("reads the whole chat list and the Activity feed, and pushes nothing at the first check", async () => {
    chats([["Anna Rossi", "ciao", true]]);
    expect(await check(agent(), cmd)).toBe("done");
    expect(vi.mocked(scanChatsFull)).toHaveBeenCalledOnce();
    expect(vi.mocked(readActivity)).toHaveBeenCalledWith(expect.anything(), expect.any(Number));
    expect(alerts).toEqual([]);
  });

  it("pushes once when a chat or a notification is unread that was not at the previous check", async () => {
    chats([["Anna Rossi", "ciao", true]]);
    feed([["a1", true]]);
    await check(agent(), cmd);
    chats([["Luca Bianchi", "ping", true], ["Anna Rossi", "ciao", true]]);
    feed([["a2", true], ["a1", true]]);
    await check(agent(), cmd);
    expect(alerts).toEqual(["2 unread chats, 1 new notification: Found by the check: open TeamsRelay to read them."]);
  });

  it("pushes for a chat unread at both checks that has a new message, not for one that did not change", async () => {
    chats([["Anna Rossi", "ciao", true], ["Luca Bianchi", "ping", true]]);
    await check(agent(), cmd);
    await check(agent(), cmd);
    expect(alerts).toEqual([]);
    chats([["Anna Rossi", "are you there?", true], ["Luca Bianchi", "ping", true]]);
    await check(agent(), cmd);
    expect(alerts).toHaveLength(1);
  });

  it("pushes each missed call the check finds on its own, and leaves it out of the new notifications", async () => {
    feedWithCalls([["a1", true]]);
    await check(agent(), cmd);
    feedWithCalls([["c1", true, "Anna Rossi", "1:15 PM"], ["a2", true], ["c2", true, "Luca Bianchi", "Yesterday"], ["a1", true]]);
    await check(agent(), cmd);
    expect(missed).toEqual([
      ["Anna Rossi", "1:15 PM"],
      ["Luca Bianchi", "Yesterday"],
    ]);
    expect(alerts).toEqual(["1 new notification: Found by the check: open TeamsRelay to read them."]);
  });

  it("pushes only the missed call when nothing else is new", async () => {
    feedWithCalls([["a1", true]]);
    await check(agent(), cmd);
    feedWithCalls([["c1", true, "Anna Rossi", "1:15 PM"], ["a1", true]]);
    await check(agent(), cmd);
    expect(missed).toEqual([["Anna Rossi", "1:15 PM"]]);
    expect(alerts).toEqual([]);
  });

  it("pushes no missed call at the first check, nor one already unread at the previous check, nor one read elsewhere", async () => {
    feedWithCalls([["c1", true, "Anna Rossi", "9:02 AM"]]);
    await check(agent(), cmd);
    feedWithCalls([["c2", false, "Luca Bianchi", "1:15 PM"], ["c1", true, "Anna Rossi", "9:02 AM"]]);
    await check(agent(), cmd);
    expect(missed).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it("pushes no missed call the previous check could not have seen, its feed not read, and keeps the last feed it read", async () => {
    vi.mocked(readActivity).mockResolvedValue(null);
    await check(agent(), cmd);
    vi.mocked(readActivity).mockResolvedValue(1);
    feedWithCalls([["c1", true, "Anna Rossi", "9:02 AM"]]);
    await check(agent(), cmd);
    expect(missed).toEqual([]);
    vi.mocked(readActivity).mockResolvedValue(null);
    feedWithCalls([["c2", true, "Luca Bianchi", "1:15 PM"], ["c1", true, "Anna Rossi", "9:02 AM"]]);
    await check(agent(), cmd);
    expect(missed).toEqual([]);
    vi.mocked(readActivity).mockResolvedValue(1);
    await check(agent(), cmd);
    expect(missed).toEqual([["Luca Bianchi", "1:15 PM"]]);
  });

  it("records what it found before the pushes: a push that fails is not sent again by the next check", async () => {
    feedWithCalls([["a1", true]]);
    await check(agent(), cmd);
    feedWithCalls([["c1", true, "Anna Rossi", "1:15 PM"], ["a1", true]]);
    const failing = { ...agent(), notifier: { ...agent().notifier, missedCall: async () => Promise.reject(new Error("push service down")) } } as unknown as Agent;
    await expect(check(failing, cmd)).resolves.toBe("done");
    await check(agent(), cmd);
    expect(missed).toEqual([]);
  });

  it("never counts muted chats or the chat with yourself", async () => {
    await check(agent(), cmd);
    store.saveChats([{ name: "Noise", preview: "x", time: "", unread: true, mention: false, muted: true, av: "" }, { name: "Me (You)", preview: "x", time: "", unread: true, mention: false, muted: false, av: "" }], true);
    await check(agent(), cmd);
    expect(alerts).toEqual([]);
  });

  it("fails when the chat list could not be read; not for a feed that could not be read (an empty one reads as failed)", async () => {
    vi.mocked(readActivity).mockResolvedValue(null);
    expect(await check(agent(), cmd)).toBe("done");
    vi.mocked(readActivity).mockResolvedValue(1);
    vi.mocked(scanChatsFull).mockResolvedValue(null);
    expect(await check(agent(), cmd)).toBe("failed");
  });
});
