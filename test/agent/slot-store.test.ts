import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatEntry } from "@/agent/logic/chats";
import { SlotStore } from "@/agent/store/slot-store";
import { tempDir } from "../helpers";

const chat = (name: string, extra: Partial<ChatEntry> = {}): ChatEntry => ({ name, preview: "", time: "", unread: false, mention: false, muted: false, av: "", ...extra });

let store: SlotStore;

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "state", "relay.db"));
});

describe("relay store", () => {
  it("creates the database with its folder", () => {
    expect(store.chats()).toEqual([]);
  });

  it("keeps the chat list in the order Teams shows it", () => {
    store.saveChats([chat("Anna Rossi", { preview: "ciao", time: "10:30", unread: true, av: "0123456789abcdef.png" }), chat("Release notes", { muted: true })]);
    expect(store.chats()).toEqual([chat("Anna Rossi", { preview: "ciao", time: "10:30", unread: true, av: "0123456789abcdef.png" }), chat("Release notes", { muted: true })]);
    store.saveChats([]);
    expect(store.chats()).toHaveLength(2);
    expect(store.isKnownChat("Release notes")).toBe(true);
  });

  it("replaces the messages of one chat and leaves the others", () => {
    store.saveChatMessages("B", [{ mid: "b1", author: "", text: "other", mine: true, reacts: "", extra: null }]);
    store.saveChatMessages("A", [{ mid: "a1", author: "Anna", text: "old", mine: false, reacts: "", extra: null }]);
    store.saveChatMessages("A", [
      { mid: "a2", author: "Anna", text: "hi", mine: false, reacts: "👍", extra: { html: "<b>hi</b>", reactions: [{ e: "👍", n: 1, mine: true }] } },
      { mid: "a3", author: "", text: "ok", mine: true, reacts: "", extra: { status: "Seen" } },
    ]);
    expect(store.messages("A")).toEqual([
      { mid: "a2", author: "Anna", text: "hi", mine: 0, reacts: "👍", html: "<b>hi</b>", reactions: [{ e: "👍", n: 1, mine: true }] },
      { mid: "a3", author: "", text: "ok", mine: 1, reacts: "", status: "Seen" },
    ]);
    expect(store.messages("B")).toHaveLength(1);
    expect(store.messages("nobody")).toEqual([]);
  });

  it("hands out pending commands in order and records their outcome", () => {
    const ids = [store.enqueue("open", "Anna Rossi"), store.enqueue("react", "Anna Rossi", '{"mid":"a2","emoji":"like"}')];
    expect(store.hasPendingCommands()).toBe(true);
    expect(store.pendingCommands()).toEqual([
      { id: ids[0], type: "open", arg1: "Anna Rossi", arg2: "" },
      { id: ids[1], type: "react", arg1: "Anna Rossi", arg2: '{"mid":"a2","emoji":"like"}' },
    ]);
    store.finishCommand(ids[0], "done");
    store.finishCommand(ids[1], "failed");
    expect([store.commandStatus(ids[0]), store.commandStatus(ids[1]), store.commandStatus(999)]).toEqual(["done", "failed", null]);
    expect(store.hasPendingCommands()).toBe(false);
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

  it("keeps one subscription per device", () => {
    store.savePushSubscription("https://push.example/1", '{"endpoint":"https://push.example/1"}', "phone");
    store.savePushSubscription("https://push.example/1", '{"endpoint":"https://push.example/1","v":2}', "phone");
    store.savePushSubscription("https://push.example/2", '{"endpoint":"https://push.example/2"}', "pc");
    expect(store.pushSubscriptionCount()).toBe(2);
    expect(store.pushSubscriptions()[0]).toEqual({ endpoint: "https://push.example/1", sub: '{"endpoint":"https://push.example/1","v":2}' });
    expect(store.deletePushSubscription("https://push.example/1")).toBe(true);
    expect(store.deletePushSubscription("https://push.example/1")).toBe(false);
    expect(store.pushSubscriptionCount()).toBe(1);
  });

  it("keeps state and the history of notifications", () => {
    expect(store.getState("missing")).toBe("");
    store.setState("active_chat", "Anna Rossi");
    expect(store.getState("active_chat")).toBe("Anna Rossi");
    expect(store.lastNotificationTs()).toBe(0);
    store.addNotification("Anna Rossi", "ciao");
    expect(store.lastNotificationTs()).toBeGreaterThan(0);
  });
});
