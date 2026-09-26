import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  adoptLegacyData,
  claimSlot,
  countPushSubscriptions,
  deletePushSubscriptionsOf,
  listSlots,
  migrateAppSchema,
  openAppDb,
  releaseSlot,
  savePushSubscription,
  slotOwner,
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
});

describe("legacy data", () => {
  it("hands the slots and devices of the previous release to one user, once", () => {
    db.exec("CREATE TABLE accounts(slot INTEGER PRIMARY KEY, added INTEGER)");
    db.exec("CREATE TABLE push_subs(endpoint TEXT PRIMARY KEY, sub TEXT)");
    db.prepare("INSERT INTO accounts VALUES(1, 100), (3, 300)").run();
    db.prepare("INSERT INTO push_subs VALUES('https://push/a', '{\"endpoint\":\"https://push/a\"}')").run();

    expect(adoptLegacyData(db, "admin-1")).toEqual({ slots: 2, devices: 1 });
    expect(listSlots(db)).toEqual([
      { slot: 1, owner_id: "admin-1", added: 100 },
      { slot: 3, owner_id: "admin-1", added: 300 },
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
    expect(claimSlot(db, "u1", { slotCount: 4, perUser: 4 })).toBe(1);
    expect(claimSlot(db, "u2", { slotCount: 4, perUser: 4 })).toBe(2);
    releaseSlot(db, 1);
    expect(claimSlot(db, "u2", { slotCount: 4, perUser: 4 })).toBe(1);
    expect(slotsOf(db, "u2").map((s) => s.slot)).toEqual([1, 2]);
    expect(slotOwner(db, 1)).toBe("u2");
  });

  it("refuses when every slot is taken", () => {
    claimSlot(db, "u1", { slotCount: 2, perUser: 4 });
    claimSlot(db, "u2", { slotCount: 2, perUser: 4 });
    expect(() => claimSlot(db, "u3", { slotCount: 2, perUser: 4 })).toThrow(/No free slot/);
  });

  it("refuses beyond the per-user cap", () => {
    claimSlot(db, "u1", { slotCount: 4, perUser: 1 });
    expect(() => claimSlot(db, "u1", { slotCount: 4, perUser: 1 })).toThrow(/at most 1/);
  });
});

describe("push subscriptions", () => {
  it("belong to one user and move with a new subscribe", () => {
    savePushSubscription(db, "u1", { endpoint: "https://push/x", keys: {} });
    savePushSubscription(db, "u2", { endpoint: "https://push/y", keys: {} });
    expect(countPushSubscriptions(db, "u1")).toBe(1);
    savePushSubscription(db, "u2", { endpoint: "https://push/x", keys: {} });
    expect(countPushSubscriptions(db, "u1")).toBe(0);
    expect(countPushSubscriptions(db, "u2")).toBe(2);
    deletePushSubscriptionsOf(db, "u2");
    expect(countPushSubscriptions(db, "u2")).toBe(0);
  });

  it("rejects a subscription without endpoint", () => {
    expect(() => savePushSubscription(db, "u1", { keys: {} })).toThrow(/endpoint/);
  });
});
