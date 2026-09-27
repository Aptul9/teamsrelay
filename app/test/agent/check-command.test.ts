import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { check } from "@/agent/commands/check";
import type { Agent } from "@/agent/context";
import { readActivity } from "@/agent/jobs/activity";
import { scanChatsFull } from "@/agent/jobs/chat-list";
import type { Notifier } from "@/agent/push/notifier";
import { SlotStore, type ActivityEntry } from "@/agent/store/slot-store";
import { STATE } from "@/shared/slot-db/state";
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

const mention = (id: string, unread = false) =>
  ({ id, kind: "mention", actor: "", title: "", emoji: "", preview: "", tm: "", chat: "", channel: false, unread, av: "" }) as ActivityEntry;
const missedCall = (id: string, caller: string, tm: string) =>
  ({ id, kind: "call", actor: caller, title: `Missed call from ${caller}`, emoji: "", preview: "Teams call", tm, chat: caller, channel: false, unread: false, av: "" }) as ActivityEntry;
// the first n items of the feed as a read shows them, newest first: m0, m1... with other items in place of some
const feedTop = (n: number, put: Record<number, ActivityEntry> = {}) => Array.from({ length: n }, (_, i) => put[i] ?? mention(`m${i}`));

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

  it("pushes no missed call at the first check, nor one the previous check already found", async () => {
    feedWithCalls([["c1", true, "Anna Rossi", "9:02 AM"]]);
    await check(agent(), cmd);
    feedWithCalls([["c1", false, "Anna Rossi", "9:02 AM"]]);
    await check(agent(), cmd);
    expect(missed).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it("pushes a missed call Teams shows as read: it never shows one bold, new or not", async () => {
    feedWithCalls([["c1", false, "Anna Rossi", "9:02 AM"]]);
    await check(agent(), cmd);
    feedWithCalls([["c2", false, "Luca Bianchi", "1:15 PM"], ["c1", false, "Anna Rossi", "9:02 AM"]]);
    await check(agent(), cmd);
    expect(missed).toEqual([["Luca Bianchi", "1:15 PM"]]);
    expect(alerts).toEqual([]);
    await check(agent(), cmd);
    expect(missed).toHaveLength(1);
  });

  it("keeps the missed calls and the unread items of the recent reads in check_seen", async () => {
    feedWithCalls([["c2", false, "Luca Bianchi", "1:15 PM"], ["a1", true], ["c1", true, "Anna Rossi", "9:02 AM"]]);
    await check(agent(), cmd);
    feedWithCalls([["a2", true]]);
    await check(agent(), cmd);
    expect(JSON.parse(store.getState(STATE.checkSeen))).toMatchObject({ calls: ["c2", "c1"], activity: ["a2", "a1", "c1"], read: true });
  });

  it("pushes no older missed call a shorter read of the feed had left out", async () => {
    const old = { 37: missedCall("c-old", "Anna Rossi", "8/29") };
    store.saveActivity(feedTop(40, old));
    await check(agent(), cmd);
    store.saveActivity(feedTop(30));
    await check(agent(), cmd);
    store.saveActivity(feedTop(40, old));
    await check(agent(), cmd);
    expect(missed).toEqual([]);
  });

  it("pushes an older missed call that only a longer read shows, as new: feed items carry no time", async () => {
    store.saveActivity(feedTop(30));
    await check(agent(), cmd);
    store.saveActivity(feedTop(40, { 35: missedCall("c-old", "Anna Rossi", "8/29") }));
    await check(agent(), cmd);
    expect(missed).toEqual([["Anna Rossi", "8/29"]]);
  });

  it("counts an item that is unread again after a read as a new notification", async () => {
    store.saveActivity(feedTop(5));
    await check(agent(), cmd);
    store.saveActivity([mention("m3", true), ...feedTop(5).filter((e) => e.id !== "m3")]);
    await check(agent(), cmd);
    expect(alerts).toEqual(["1 new notification: Found by the check: open TeamsRelay to read them."]);
  });

  it("counts no unread item saved without its Teams id as a new notification: its id is its place", async () => {
    store.saveActivity([mention("x0", true)]);
    await check(agent(), cmd);
    store.saveActivity([mention("m-new"), mention("x1", true)]);
    await check(agent(), cmd);
    expect(alerts).toEqual([]);
  });

  it("never pushes a missed call saved without its Teams id: its id is its place", async () => {
    store.saveActivity([missedCall("x0", "Anna Rossi", "8/29")]);
    await check(agent(), cmd);
    store.saveActivity([mention("m-new"), missedCall("x1", "Anna Rossi", "8/29")]);
    await check(agent(), cmd);
    expect(missed).toEqual([]);
  });

  it("pushes the missed call on top of the feed after a shorter read", async () => {
    store.saveActivity(feedTop(40));
    await check(agent(), cmd);
    store.saveActivity(feedTop(30));
    await check(agent(), cmd);
    store.saveActivity([missedCall("c-new", "Luca Bianchi", "4:10 PM"), ...feedTop(39)]);
    await check(agent(), cmd);
    expect(missed).toEqual([["Luca Bianchi", "4:10 PM"]]);
  });

  it("pushes a missed call a shorter read had left out, once a longer read shows it", async () => {
    store.saveActivity(feedTop(40));
    await check(agent(), cmd);
    // a call, then 15 other items: the next read stops at 12, above the call
    const now = [...Array.from({ length: 15 }, (_, i) => mention(`a${i}`)), missedCall("c-late", "Luca Bianchi", "1:15 PM"), ...feedTop(24)];
    store.saveActivity(now.slice(0, 12));
    await check(agent(), cmd);
    expect(missed).toEqual([]);
    store.saveActivity(now);
    await check(agent(), cmd);
    expect(missed).toEqual([["Luca Bianchi", "1:15 PM"]]);
  });

  it("pushes a new missed call below an item Teams moved to the top", async () => {
    store.saveActivity(feedTop(40));
    await check(agent(), cmd);
    store.saveActivity([mention("m20"), missedCall("c-new", "Luca Bianchi", "4:10 PM"), ...feedTop(38).filter((e) => e.id !== "m20")]);
    await check(agent(), cmd);
    expect(missed).toEqual([["Luca Bianchi", "4:10 PM"]]);
  });

  it("counts no older unread notification a shorter read left out as new", async () => {
    const old = { 36: mention("n-old", true) };
    store.saveActivity(feedTop(40, old));
    await check(agent(), cmd);
    store.saveActivity(feedTop(30));
    await check(agent(), cmd);
    store.saveActivity(feedTop(40, old));
    await check(agent(), cmd);
    expect(alerts).toEqual([]);
  });

  it("compares with the missed calls a row of an earlier release kept", async () => {
    store.setState(STATE.checkSeen, JSON.stringify({ chats: [], activity: [], calls: ["c1"], feed: ["c1"], read: true }));
    store.saveActivity([missedCall("c2", "Luca Bianchi", "4:10 PM"), missedCall("c1", "Anna Rossi", "3:54 PM")]);
    await check(agent(), cmd);
    expect(missed).toEqual([["Luca Bianchi", "4:10 PM"]]);
  });

  it("only records the missed calls after a check of an earlier release, whose row has no calls", async () => {
    store.setState(STATE.checkSeen, JSON.stringify({ chats: [], activity: [], read: true }));
    feedWithCalls([["c1", false, "Anna Rossi", "3:54 PM"]]);
    await check(agent(), cmd);
    expect(missed).toEqual([]);
    feedWithCalls([["c2", false, "Luca Bianchi", "4:10 PM"], ["c1", false, "Anna Rossi", "3:54 PM"]]);
    await check(agent(), cmd);
    expect(missed).toEqual([["Luca Bianchi", "4:10 PM"]]);
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
