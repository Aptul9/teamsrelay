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

const agent = () => ({ store, notifier: { alert: async (title: string, body: string) => void alerts.push(`${title}: ${body}`) } as unknown as Notifier }) as unknown as Agent;
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

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  alerts = [];
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
