import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountStatus,
  accountUnread,
  appBadgeCount,
  loadSeen,
  markActivitySeen,
  parseSeen,
  seenKey,
  statusText,
  unreadInOthers,
  unseenActivity,
  unseenCalls,
  unseenIds,
  untilText,
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
  missedCalls: [],
  added: 1790000000,
  desktop: "",
  checkEvery: 0,
  checked: 0,
  checkResult: "",
  nextCheck: 0,
  checking: false,
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

describe("missed calls", () => {
  // Teams shows a missed call as read (font weight 400), new or not
  const call = (id: string, unread = 0): ActivityItem => ({ ...item(id, unread), kind: "call" });

  it("count apart from the other notifications: every missed call this device has not shown, whatever Teams shows", () => {
    const seen = markActivitySeen(null, [item("a"), call("c0")]);
    const items = [call("c1"), item("n1"), call("c2", 1), item("a"), call("c0")];
    expect(unseenCalls(items, seen)).toBe(2);
    expect(unseenActivity(items, seen)).toBe(1);
    expect(unseenCalls(items, null)).toBe(0);
  });

  it("count in an account the app does not show, from the missed calls /api/accounts lists", () => {
    const a = account({ unreadActivity: ["n2", "n1"], missedCalls: ["c1", "c0"] });
    expect(accountUnread(a, ["n1", "c0"])).toEqual({ chats: 2, notifications: 1, calls: 1 });
    expect(accountUnread(a, ["n1", "c1", "c0"])).toEqual({ chats: 2, notifications: 1, calls: 0 });
    expect(accountUnread({ ...a, stopped: true }, ["n1"])).toEqual({ chats: 0, notifications: 0, calls: 0 });
  });

  it("leave a missed call Teams would show bold out of the notifications", () => {
    expect(accountUnread(account({ unreadActivity: ["c1", "n1"], missedCalls: ["c1"] }), [])).toEqual({ chats: 2, notifications: 1, calls: 1 });
  });

  it("add to what waits in the other accounts", () => {
    const accounts = [account({ slot: 1 }), account({ slot: 2, unread: 0, unreadActivity: [], missedCalls: ["c1"] })];
    expect(unreadInOthers(accounts, 1, (a) => accountUnread(a, []))).toBe(1);
  });
});

describe("appBadgeCount", () => {
  it("adds what waits in every account, the one on screen included, for the icon of the installed app", () => {
    const accounts = [account({ slot: 1, unread: 1 }), account({ slot: 2, unread: 2, missedCalls: ["n1"] }), account({ slot: 3, unread: 4, stopped: true })];
    const unreadOf = (a: Account) => accountUnread(a, a.slot === 1 ? ["n2", "n1"] : []);
    expect(appBadgeCount(accounts, unreadOf)).toBe(1 + (2 + 1 + 1));
    expect(appBadgeCount([], unreadOf)).toBe(0);
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
    expect(accountUnread(account(), ["n1"])).toEqual({ chats: 2, notifications: 1, calls: 0 });
  });

  it("counts no notification before the feed was read or first seen here", () => {
    expect(accountUnread(account({ unreadActivity: null }), ["n1"])).toEqual({ chats: 2, notifications: 0, calls: 0 });
    expect(accountUnread(account(), null)).toEqual({ chats: 2, notifications: 0, calls: 0 });
  });

  it("counts what the last check found for an account checked every N hours, whose browser runs only then", () => {
    expect(accountUnread(account({ checkEvery: 3600, checked: 1790000000 }), ["n1"])).toEqual({ chats: 2, notifications: 1, calls: 0 });
  });

  it("counts nothing for a stopped account, whose numbers would stay until it starts", () => {
    expect(accountUnread(account({ stopped: true }), [])).toEqual({ chats: 0, notifications: 0, calls: 0 });
  });
});

describe("accountStatus", () => {
  it("is one of stopped, always on (0) or the interval of the checks: a stopped account is stopped whatever its interval", () => {
    expect(accountStatus(account({ stopped: true, checkEvery: 14400 }))).toBe("stopped");
    expect(accountStatus(account({ checkEvery: 0 }))).toBe(0);
    expect(accountStatus(account({ checkEvery: 7200 }))).toBe(7200);
  });
});

describe("statusText", () => {
  const now = 1790500000;

  it("says stopped, active for an account always on, or when the next check updates a checked one", () => {
    expect(statusText(account({ stopped: true, checkEvery: 3600, nextCheck: now + 600 }), now)).toBe("Stopped");
    expect(statusText(account({ checkEvery: 0 }), now)).toBe("Active");
    expect(statusText(account({ checkEvery: 3600, checking: true, nextCheck: now + 3600 }), now)).toBe("Updating now");
    expect(statusText(account({ checkEvery: 7200, nextCheck: now + 80 * 60 }), now)).toBe("Updating in 1 h 20 min");
  });

  it("says soon for a check asked from the app (no time) or already due, waiting for another account's check", () => {
    expect(statusText(account({ checkEvery: 3600, nextCheck: 0 }), now)).toBe("Updating soon");
    expect(statusText(account({ checkEvery: 3600, nextCheck: now - 30 }), now)).toBe("Updating soon");
  });
});

describe("untilText", () => {
  it("counts whole minutes up to the hour, then hours and minutes; under a minute is one", () => {
    expect(untilText(20)).toBe("1 min");
    expect(untilText(45 * 60)).toBe("45 min");
    expect(untilText(59 * 60 + 30)).toBe("1 h");
    expect(untilText(2 * 3600)).toBe("2 h");
    expect(untilText(3 * 3600 + 59 * 60)).toBe("3 h 59 min");
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
    expect(accountUnread(later, seen[2])).toEqual({ chats: 2, notifications: 1, calls: 0 });
  });

  it("takes the missed calls of an account met for the first time as seen too, and counts the next one", () => {
    const a = account({ unreadActivity: ["n1"], missedCalls: ["c2", "c1"] });
    expect(loadSeen([a])).toEqual({ 2: ["n1", "c2", "c1"] });
    const later = account({ unreadActivity: ["n1"], missedCalls: ["c3", "c2", "c1"] });
    expect(accountUnread(later, loadSeen([later])[2])).toEqual({ chats: 2, notifications: 0, calls: 1 });
  });

  it("stores nothing for an account whose feed the agent has not saved yet", () => {
    expect(loadSeen([account({ unreadActivity: null, missedCalls: null })])).toEqual({});
    expect(store.size).toBe(0);
  });

  it("does not give the list of a removed account to the next one on the same slot", () => {
    loadSeen([account({ added: 1790000000, unreadActivity: ["old"] })]);
    const next = account({ added: 1790003600, unreadActivity: ["b1", "b2"] });
    const seen = loadSeen([next]);
    expect(accountUnread(next, seen[2])).toEqual({ chats: 2, notifications: 0, calls: 0 });
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
