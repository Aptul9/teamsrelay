import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountUnread,
  loadSeen,
  markActivitySeen,
  parseSeen,
  seenKey,
  unreadInOthers,
  unseenActivity,
  unseenIds,
  type Account,
  type ActivityItem,
} from "@/lib/client";

const item = (id: string, unread = 1): ActivityItem => ({
  id,
  unread,
  kind: "reaction",
  actor: "",
  title: "",
  emoji: "",
  preview: "",
  tm: "",
  chat: "",
  channel: 0,
  av: "",
});

const account = (extra: Partial<Account> = {}): Account => ({
  slot: 2,
  name: "Anna Rossi",
  email: "anna.rossi@contoso.example",
  tenant: "Contoso",
  av: "",
  teams: "ok",
  overall: "green",
  stopped: false,
  unread: 2,
  unreadActivity: ["n2", "n1"],
  added: 1790000000,
  desktop: "",
  ...extra,
});

describe("unseenActivity", () => {
  it("counts nothing before the feed was first looked at", () => {
    expect(unseenActivity([item("a"), item("b")], null)).toBe(0);
  });

  it("counts unread items that arrived after the last look", () => {
    const seen = markActivitySeen(null, [item("a"), item("b", 0)]);
    expect(unseenActivity([item("c"), item("a"), item("b", 0)], seen)).toBe(1);
  });

  it("never counts read items", () => {
    expect(unseenActivity([item("c", 0), item("d", 0)], [])).toBe(0);
  });

  it("stops counting an item once the feed is looked at", () => {
    const items = [item("c"), item("a")];
    expect(unseenActivity(items, markActivitySeen(["a"], items))).toBe(0);
  });
});

describe("markActivitySeen", () => {
  it("keeps the ids that left the feed, newest first, up to 200", () => {
    const seen = markActivitySeen(["x", "y"], [item("a"), item("x")]);
    expect(seen).toEqual(["a", "x", "y"]);
    const many = Array.from({ length: 250 }, (_, i) => `old${i}`);
    expect(markActivitySeen(many, [item("a")])).toHaveLength(200);
  });
});

describe("unseenIds", () => {
  it("counts the unread ids not seen yet, nothing before the first look", () => {
    expect(unseenIds(["a", "b"], null)).toBe(0);
    expect(unseenIds(["c", "a"], ["a", "b"])).toBe(1);
    expect(unseenIds([], ["a"])).toBe(0);
  });
});

describe("accountUnread", () => {
  it("counts unread chats and the notifications this device has not shown", () => {
    expect(accountUnread(account(), ["n1"])).toEqual({ chats: 2, notifications: 1 });
  });

  it("counts no notification before the feed was read or first seen here", () => {
    expect(accountUnread(account({ unreadActivity: null }), ["n1"])).toEqual({ chats: 2, notifications: 0 });
    expect(accountUnread(account(), null)).toEqual({ chats: 2, notifications: 0 });
  });

  it("counts nothing for a stopped account, whose numbers would stay until it starts", () => {
    expect(accountUnread(account({ stopped: true }), [])).toEqual({ chats: 0, notifications: 0 });
  });
});

describe("unreadInOthers", () => {
  it("adds what waits in every account but the one on screen, for the menu button and the back arrow of a chat", () => {
    const seen = { 1: ["n2", "n1"], 2: ["n1"], 3: [] as string[] };
    const accounts = [account({ slot: 1, unread: 1 }), account({ slot: 2, unread: 2 }), account({ slot: 3, unread: 4, stopped: true })];
    const unreadOf = (a: Account) => accountUnread(a, seen[a.slot as 1 | 2 | 3]);
    expect(unreadInOthers(accounts, 1, unreadOf)).toBe(3);
    expect(unreadInOthers(accounts, 2, unreadOf)).toBe(1);
    expect(unreadInOthers(accounts, 0, unreadOf)).toBe(4);
    expect(unreadInOthers([], 1, unreadOf)).toBe(0);
  });
});

describe("loadSeen", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("takes as seen what an account met for the first time has unread, and keeps it", () => {
    expect(loadSeen([account()])).toEqual({ 2: ["n2", "n1"] });
    expect(store.get(seenKey(account()))).toBe(JSON.stringify(["n2", "n1"]));
    const later = account({ unreadActivity: ["n3", "n2", "n1"] });
    const seen = loadSeen([later]);
    expect(seen).toEqual({ 2: ["n2", "n1"] });
    expect(accountUnread(later, seen[2])).toEqual({ chats: 2, notifications: 1 });
  });

  it("stores nothing for an account whose feed the agent has not saved yet", () => {
    expect(loadSeen([account({ unreadActivity: null })])).toEqual({});
    expect(store.size).toBe(0);
  });

  it("does not give the list of a removed account to the next one on the same slot", () => {
    loadSeen([account({ added: 1790000000, unreadActivity: ["old"] })]);
    const next = account({ added: 1790003600, unreadActivity: ["b1", "b2"] });
    const seen = loadSeen([next]);
    expect(accountUnread(next, seen[2])).toEqual({ chats: 2, notifications: 0 });
  });
});

describe("parseSeen", () => {
  it("reads what markActivitySeen stored, nothing else", () => {
    expect(parseSeen(JSON.stringify(["a", "b"]))).toEqual(["a", "b"]);
    expect(parseSeen(null)).toBeNull();
    expect(parseSeen("{")).toBeNull();
    expect(parseSeen('{"a":1}')).toBeNull();
  });
});
