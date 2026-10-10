import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  adoptLegacyData,
  askCheck,
  beginCheck,
  claimSlot,
  countPushSubscriptions,
  deletePushSubscriptionsOf,
  endCheck,
  isSlotStopped,
  listSlots,
  migrateAppSchema,
  nextCheck,
  openAppDb,
  releaseSlot,
  savePushSubscription,
  setCheckEvery,
  setSlotStopped,
  slotOwner,
  slotRow,
  slotsOf,
} from "@/lib/appdb";
import { tempDir } from "./helpers";

let db: Database.Database;

beforeEach(() => {
  db = openAppDb(path.join(tempDir(), "app.db"));
  migrateAppSchema(db);
});

describe("schema", () => {
  it("is idempotent", () => {
    migrateAppSchema(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all();
    expect(tables).toEqual(expect.arrayContaining(["push_subscriptions", "teams_accounts"]));
  });

  it("adds stopped, started and the checks to the accounts of the first multi-user release, running and always on", () => {
    const old = openAppDb(path.join(tempDir(), "app.db"));
    old.exec("CREATE TABLE teams_accounts(slot INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, added INTEGER NOT NULL)");
    old.prepare("INSERT INTO teams_accounts VALUES(2, 'u1', 100)").run();

    migrateAppSchema(old);

    expect(listSlots(old)).toEqual([{ slot: 2, owner_id: "u1", added: 100, stopped: 0, started: 0, check_every: 0, check_due: 0, checked: 0, check_result: "", checking: 0, relay: 0, browser_off: 0 }]);
  });
});

describe("checked accounts", () => {
  it("get their first check one interval after being switched to checks, none once back to always on", () => {
    const n = claimSlot(db, "u1", { perUser: 4 });
    setCheckEvery(db, n, 7200, 1000);
    expect(slotRow(db, n)).toMatchObject({ check_every: 7200, check_due: 8200 });
    setCheckEvery(db, n, 0, 2000);
    expect(slotRow(db, n)).toMatchObject({ check_every: 0, check_due: 0 });
    expect(slotRow(db, 4)).toBeNull();
  });

  it("record a check as it starts and as it ends: time, outcome and the next one; an interrupted check records nothing", () => {
    const n = claimSlot(db, "u1", { perUser: 4 });
    setCheckEvery(db, n, 3600, 1000);
    beginCheck(db, n, 5000);
    expect(slotRow(db, n)).toMatchObject({ checking: 5000 });
    endCheck(db, n, { now: 5060, result: "login" });
    expect(slotRow(db, n)).toMatchObject({ checking: 0, checked: 5060, check_result: "login", check_due: 8660 });
    beginCheck(db, n, 9000);
    endCheck(db, n, { now: 9010, result: null });
    expect(slotRow(db, n)).toMatchObject({ checking: 0, checked: 5060, check_result: "login", check_due: 8660 });
  });

  it("are due in the order of their due time, one asked by its owner first; never stopped or always-on ones", () => {
    for (let i = 0; i < 4; i++) claimSlot(db, "u1", { perUser: 4 });
    setCheckEvery(db, 1, 3600, 0);
    setCheckEvery(db, 2, 3600, -10);
    setCheckEvery(db, 3, 3600, -20);
    setSlotStopped(db, 3, true);
    expect(nextCheck(db, 3500)).toBeNull();
    expect(nextCheck(db, 3600)?.slot).toBe(2);
    askCheck(db, 1);
    expect(nextCheck(db, 3600)?.slot).toBe(1);
  });
});

describe("stopped accounts", () => {
  it("keep their owner; a start records its time", () => {
    const n = claimSlot(db, "u1", { perUser: 4 });
    setSlotStopped(db, n, true);
    expect(isSlotStopped(db, n)).toBe(true);
    expect(slotOwner(db, n)).toBe("u1");

    const before = Math.floor(Date.now() / 1000);
    setSlotStopped(db, n, false);
    expect(isSlotStopped(db, n)).toBe(false);
    expect(slotsOf(db, "u1")[0].started).toBeGreaterThanOrEqual(before);
  });

  it("an unknown slot is not stopped", () => {
    expect(isSlotStopped(db, 4)).toBe(false);
  });
});

describe("legacy data", () => {
  it("hands the slots and devices of the previous release to one user, once", () => {
    db.exec("CREATE TABLE accounts(slot INTEGER PRIMARY KEY, added INTEGER)");
    db.exec("CREATE TABLE push_subs(endpoint TEXT PRIMARY KEY, sub TEXT)");
    db.prepare("INSERT INTO accounts VALUES(1, 100), (3, 300)").run();
    db.prepare("INSERT INTO push_subs VALUES('https://push/a', '{\"endpoint\":\"https://push/a\"}')").run();

    expect(adoptLegacyData(db, "admin-1")).toEqual({ slots: 2, devices: 1 });
    expect(listSlots(db)).toEqual([
      { slot: 1, owner_id: "admin-1", added: 100, stopped: 0, started: 0, check_every: 0, check_due: 0, checked: 0, check_result: "", checking: 0, relay: 0, browser_off: 0 },
      { slot: 3, owner_id: "admin-1", added: 300, stopped: 0, started: 0, check_every: 0, check_due: 0, checked: 0, check_result: "", checking: 0, relay: 0, browser_off: 0 },
    ]);
    expect(countPushSubscriptions(db, "admin-1")).toBe(1);

    db.prepare("INSERT INTO accounts VALUES(2, 200)").run();
    expect(adoptLegacyData(db, "someone-else")).toEqual({ slots: 0, devices: 0 });
    expect(slotOwner(db, 2)).toBeNull();
  });

  it("works on a fresh database without legacy tables", () => {
    expect(adoptLegacyData(db, "admin-1")).toEqual({ slots: 0, devices: 0 });
  });
});

describe("slots", () => {
  it("claims the lowest free slot", () => {
    expect(claimSlot(db, "u1", { perUser: 4 })).toBe(1);
    expect(claimSlot(db, "u2", { perUser: 4 })).toBe(2);
    releaseSlot(db, 1);
    expect(claimSlot(db, "u2", { perUser: 4 })).toBe(1);
    expect(slotsOf(db, "u2").map((s) => s.slot)).toEqual([1, 2]);
    expect(slotOwner(db, 1)).toBe("u2");
  });

  it("has no limit on the number of slots", () => {
    for (let n = 1; n <= 12; n++) expect(claimSlot(db, `u${n}`, { perUser: 4 })).toBe(n);
    releaseSlot(db, 5);
    expect(claimSlot(db, "u13", { perUser: 4 })).toBe(5);
    expect(claimSlot(db, "u14", { perUser: 4 })).toBe(13);
  });

  it("gives one user as many slots as they ask when there is no per-user cap", () => {
    for (let n = 1; n <= 9; n++) expect(claimSlot(db, "u1", { perUser: null })).toBe(n);
    expect(slotsOf(db, "u1")).toHaveLength(9);
  });

  it("refuses beyond the per-user cap", () => {
    claimSlot(db, "u1", { perUser: 1 });
    expect(() => claimSlot(db, "u1", { perUser: 1 })).toThrow(/at most 1/);
  });
});

// keys as a browser gives them (base64url)
const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };

describe("push subscriptions", () => {
  it("belong to one user and move with a new subscribe", () => {
    savePushSubscription(db, "u1", { endpoint: "https://push/x", keys: KEYS });
    savePushSubscription(db, "u2", { endpoint: "https://push/y", keys: KEYS });
    expect(countPushSubscriptions(db, "u1")).toBe(1);
    savePushSubscription(db, "u2", { endpoint: "https://push/x", keys: KEYS });
    expect(countPushSubscriptions(db, "u1")).toBe(0);
    expect(countPushSubscriptions(db, "u2")).toBe(2);
    deletePushSubscriptionsOf(db, "u2");
    expect(countPushSubscriptions(db, "u2")).toBe(0);
  });

  it("rejects a subscription without endpoint", () => {
    expect(() => savePushSubscription(db, "u1", { keys: KEYS })).toThrow(/endpoint/);
    expect(() => savePushSubscription(db, "u1", { endpoint: "https://push/z", keys: {} })).toThrow(/keys/);
  });
});
