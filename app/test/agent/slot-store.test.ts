import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatEntry } from "@/agent/logic/chats";
import { SlotStore } from "@/agent/store/slot-store";
import { SlotReader } from "@/lib/slotdb";
import { CALL_LOG_SIZE } from "@/shared/slot-db/schema";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

const chat = (name: string, extra: Partial<ChatEntry> = {}): ChatEntry => ({ name, preview: "", time: "", unread: false, mention: false, muted: false, av: "", ...extra });

let file: string;
let store: SlotStore;

beforeEach(() => {
  file = path.join(tempDir(), "2", "messages.db");
  store = SlotStore.open(file);
});

// What the agent writes, the web app reads (src/lib/slotdb.ts)
function reader<T>(fn: (r: SlotReader) => T): T {
  const r = SlotReader.open(file);
  try {
    return fn(r);
  } finally {
    r.close();
  }
}

describe("agent store", () => {
  it("creates the slot database with its folder", () => {
    expect(reader((r) => r.chats())).toEqual([]);
  });

  it("writes the chat list the web app shows", () => {
    store.saveChats([chat("Anna Rossi", { preview: "ciao", time: "10:30", unread: true, av: "0123456789abcdef.png" }), chat("Release notes", { muted: true })]);
    expect(reader((r) => r.chats())).toEqual([
      { name: "Anna Rossi", preview: "ciao", tm: "10:30", unread: 1, mention: 0, muted: 0, av: "0123456789abcdef.png" },
      { name: "Release notes", preview: "", tm: "", unread: 0, mention: 0, muted: 1, av: "" },
    ]);
    store.saveChats([]);
    expect(reader((r) => r.chats())).toHaveLength(2);
    expect(store.chats()[0]).toEqual(chat("Anna Rossi", { preview: "ciao", time: "10:30", unread: true, av: "0123456789abcdef.png" }));
  });

  it("replaces the messages of one chat and leaves the others", () => {
    store.saveChatMessages("B", [{ mid: "b1", author: "", text: "other", mine: true, reacts: "", extra: null }]);
    store.saveChatMessages("A", [{ mid: "a1", author: "Anna", text: "old", mine: false, reacts: "", extra: null }]);
    store.saveChatMessages("A", [
      { mid: "a2", author: "Anna", text: "hi", mine: false, reacts: "👍", extra: { html: "<b>hi</b>", reactions: [{ e: "👍", n: 1, mine: true }] } },
      { mid: "a3", author: "", text: "ok", mine: true, reacts: "", extra: { status: "Seen" } },
    ]);
    expect(reader((r) => r.messages("A"))).toEqual([
      { mid: "a2", author: "Anna", text: "hi", mine: 0, reacts: "👍", html: "<b>hi</b>", reactions: [{ e: "👍", n: 1, mine: true }] },
      { mid: "a3", author: "", text: "ok", mine: 1, reacts: "", status: "Seen" },
    ]);
    expect(reader((r) => r.messages("B"))).toHaveLength(1);
    expect(store.ownRecentMessageIds("A", 5)).toEqual(["a3"]);
  });

  it("keeps the read receipts of your messages", () => {
    store.saveReadBy("a3", "A", { label: "Read by 1 of 2", names: ["Anna Rossi"] });
    expect(store.readByCache(["a3", "zz"])).toEqual(new Map([["a3", { label: "Read by 1 of 2", names: ["Anna Rossi"] }]]));
    expect(store.readByOf("A").get("a3")?.label).toBe("Read by 1 of 2");
    expect(store.readByCache([])).toEqual(new Map());
  });

  it("hands out pending commands in order and records their outcome", () => {
    const ids = ["open", "react"].map((type) => reader((r) => r.enqueue(type as "open", "Anna Rossi", type === "react" ? '{"mid":"a2","emoji":"like"}' : "")));
    expect(store.hasPendingCommands()).toBe(true);
    expect(store.pendingCommands()).toEqual([
      { id: ids[0], type: "open", arg1: "Anna Rossi", arg2: "" },
      { id: ids[1], type: "react", arg1: "Anna Rossi", arg2: '{"mid":"a2","emoji":"like"}' },
    ]);
    store.finishCommand(ids[0], "done");
    store.finishCommand(ids[1], "failed");
    expect(reader((r) => [r.commandStatus(ids[0])?.status, r.commandStatus(ids[1])?.status])).toEqual(["done", "failed"]);
    expect(store.hasPendingCommands()).toBe(false);
  });

  it("queues commands itself and reads back their outcome, like the web app does (local relay API)", () => {
    const id = store.enqueue("send", "Anna Rossi", "hello");
    expect(store.commandStatus(id)).toBe("pending");
    expect(reader((r) => r.commandStatus(id)?.status)).toBe("pending");
    store.finishCommand(id, "done");
    expect([store.commandStatus(id), store.commandStatus(999)]).toEqual(["done", null]);
  });

  it("queues a command with a key once: the same key gives back the first command", () => {
    const first = store.enqueue("send", "Anna Rossi", "hello", "k0123456789abcdef");
    expect(store.enqueue("send", "Anna Rossi", "hello", "k0123456789abcdef")).toBe(first);
    expect(store.enqueue("send", "Anna Rossi", "hello")).not.toBe(first);
    expect(store.enqueue("send", "Anna Rossi", "hello")).not.toBe(first);
    expect(store.enqueue("send", "Anna Rossi", "hello", "k-another-key-01")).not.toBe(first);
    expect(store.pendingCommands()).toHaveLength(4);
  });

  it("ends as failed the commands that waited too long, and only those", () => {
    const now = Math.floor(Date.now() / 1000);
    const old = store.enqueue("send", "Anna Rossi", "queued while signed out");
    const recent = store.enqueue("send", "Anna Rossi", "just now");
    expect(store.expirePendingCommands(120, now + 60)).toBe(0);
    expect(store.expirePendingCommands(120, now + 130)).toBe(2);
    expect([store.commandStatus(old), store.commandStatus(recent)]).toEqual(["failed", "failed"]);
    const fresh = store.enqueue("send", "Anna Rossi", "fresh");
    store.finishCommand(fresh, "done");
    expect(store.expirePendingCommands(0, now + 999)).toBe(0);
    expect(store.commandStatus(fresh)).toBe("done");
  });

  it("reads back the messages of a chat as the web app does", () => {
    store.saveChatMessages("A", [
      { mid: "a2", author: "Anna", text: "hi", mine: false, reacts: "👍", extra: { html: "<b>hi</b>", reactions: [{ e: "👍", n: 1, mine: true }] } },
      { mid: "a3", author: "", text: "ok", mine: true, reacts: "", extra: null },
    ]);
    expect(store.messages("A")).toEqual(reader((r) => r.messages("A")));
    expect(store.messages("A")).toEqual([
      { mid: "a2", author: "Anna", text: "hi", mine: 0, reacts: "👍", html: "<b>hi</b>", reactions: [{ e: "👍", n: 1, mine: true }] },
      { mid: "a3", author: "", text: "ok", mine: 1, reacts: "" },
    ]);
    expect(store.messages("nobody")).toEqual([]);
  });

  it("rewrites the activity feed", () => {
    const item = { kind: "reaction", actor: "Anna Rossi", title: "Anna Rossi reacted", emoji: "👍", preview: "ok", tm: "9/24", chat: "Anna Rossi", channel: false, unread: true, av: "" };
    store.saveActivity([{ id: "101", ...item }, { id: "", ...item, channel: true }]);
    expect(reader((r) => r.activity().items.map((a) => [a.id, a.channel, a.unread]))).toEqual([
      ["101", 0, 1],
      ["x1", 1, 1],
    ]);
  });

  it("keeps the calls it saw ring, the last ones, newest first for the web app", () => {
    expect(reader((r) => r.callLog())).toEqual([]);
    for (let i = 0; i < CALL_LOG_SIZE + 2; i++) store.addCall(`Caller ${i}`, 1_790_000_000_000 + i * 60_000, i);
    const log = reader((r) => r.callLog());
    expect(log).toHaveLength(CALL_LOG_SIZE);
    expect(log[0]).toEqual({ caller: `Caller ${CALL_LOG_SIZE + 1}`, since: 1_790_000_000_000 + (CALL_LOG_SIZE + 1) * 60_000, seconds: CALL_LOG_SIZE + 1 });
    expect(log[CALL_LOG_SIZE - 1].caller).toBe("Caller 2");
  });

  it("lists every missed call of the Activity feed, bold or not (Teams shows them as read), once the feed was read", () => {
    const item = { actor: "Anna Rossi", title: "", emoji: "", preview: "", tm: "1:15 PM", chat: "Anna Rossi", channel: false, av: "" };
    store.saveActivity([
      { id: "c1", kind: "call", unread: true, ...item },
      { id: "m1", kind: "mention", unread: true, ...item },
      { id: "c2", kind: "call", unread: false, ...item },
    ]);
    expect(reader((r) => r.missedCalls())).toBeNull();
    store.setState(STATE.activityTs, "1790000000");
    expect(reader((r) => [r.unreadActivity(), r.missedCalls(), r.activityIds()])).toEqual([["c1", "m1"], ["c1", "c2"], ["c1", "m1", "c2"]]);
    expect(store.missedCalls()).toEqual([
      { id: "c1", caller: "Anna Rossi", time: "1:15 PM" },
      { id: "c2", caller: "Anna Rossi", time: "1:15 PM" },
    ]);
  });

  it("keeps state and the history of notifications", () => {
    expect(store.getState("missing")).toBe("");
    store.setState("active_chat", "Anna Rossi");
    expect(store.getState("active_chat")).toBe("Anna Rossi");
    expect(store.lastNotificationTs()).toBe(0);
    store.addNotification("Anna Rossi", "ciao");
    expect(store.lastNotificationTs()).toBeGreaterThan(0);
    expect(reader((r) => r.feed())).toMatchObject([{ title: "Anna Rossi", body: "ciao" }]);
  });
});
