import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatEntry } from "@/agent/logic/chats";
import { SlotStore } from "@/agent/store/slot-store";
import { SlotReader } from "@/lib/slotdb";
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

  it("rewrites the activity feed", () => {
    const item = { kind: "reaction", actor: "Anna Rossi", title: "Anna Rossi reacted", emoji: "👍", preview: "ok", tm: "9/24", chat: "Anna Rossi", channel: false, unread: true, av: "" };
    store.saveActivity([{ id: "101", ...item }, { id: "", ...item, channel: true }]);
    expect(reader((r) => r.activity().items.map((a) => [a.id, a.channel, a.unread]))).toEqual([
      ["101", 0, 1],
      ["x1", 1, 1],
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
