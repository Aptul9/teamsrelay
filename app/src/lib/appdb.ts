import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config";
import { HttpError } from "./http";

// data/app.db: better-auth tables, slot ownership and push subscriptions.
// The agents read teams_accounts and push_subscriptions (src/agent/store/app-store.ts): keep the column names.
const SCHEMA_VERSION = 2;

// stopped: 1 while the owner keeps the account switched off (browser and agent stopped, session kept).
// started: last start from the app, 0 if never; the grace of a browser still starting counts from there.
export type Slot = { slot: number; owner_id: string; added: number; stopped: number; started: number };

let shared: Database.Database | null = null;

export function openAppDb(file: string): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 8000");
  return db;
}

export function appDb(): Database.Database {
  if (!shared) shared = openAppDb(config.appDb);
  return shared;
}

export function migrateAppSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams_accounts(slot INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, added INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS teams_accounts_owner ON teams_accounts(owner_id);
    CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, sub TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);
  `);
  const columns = db.prepare("SELECT name FROM pragma_table_info('teams_accounts')").pluck().all();
  if (!columns.includes("stopped")) db.exec("ALTER TABLE teams_accounts ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0");
  if (!columns.includes("started")) db.exec("ALTER TABLE teams_accounts ADD COLUMN started INTEGER NOT NULL DEFAULT 0");
}

const hasTable = (db: Database.Database, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

// The previous release had one owner: its slots (accounts) and devices (push_subs) go to the first
// administrator. The legacy tables stay untouched so a rollback still finds them.
export function adoptLegacyData(db: Database.Database, userId: string): { slots: number; devices: number } {
  return db.transaction(() => {
    if ((db.pragma("user_version", { simple: true }) as number) >= SCHEMA_VERSION) return { slots: 0, devices: 0 };
    const now = Math.floor(Date.now() / 1000);
    let slots = 0;
    let devices = 0;
    if (hasTable(db, "accounts")) {
      slots = db
        .prepare("INSERT OR IGNORE INTO teams_accounts(slot, owner_id, added) SELECT slot, ?, COALESCE(added, ?) FROM accounts")
        .run(userId, now).changes;
    }
    if (hasTable(db, "push_subs")) {
      devices = db
        .prepare("INSERT OR IGNORE INTO push_subscriptions(endpoint, user_id, sub, created) SELECT endpoint, ?, sub, ? FROM push_subs WHERE endpoint <> ''")
        .run(userId, now).changes;
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return { slots, devices };
  })();
}

export function listSlots(db: Database.Database): Slot[] {
  return db.prepare("SELECT slot, owner_id, added, stopped, started FROM teams_accounts ORDER BY slot").all() as Slot[];
}

export function slotsOf(db: Database.Database, userId: string): Slot[] {
  return db.prepare("SELECT slot, owner_id, added, stopped, started FROM teams_accounts WHERE owner_id=? ORDER BY slot").all(userId) as Slot[];
}

export function isSlotStopped(db: Database.Database, slot: number): boolean {
  return !!db.prepare("SELECT stopped FROM teams_accounts WHERE slot=?").pluck().get(slot);
}

export function setSlotStopped(db: Database.Database, slot: number, stopped: boolean) {
  if (stopped) db.prepare("UPDATE teams_accounts SET stopped=1 WHERE slot=?").run(slot);
  else db.prepare("UPDATE teams_accounts SET stopped=0, started=? WHERE slot=?").run(Math.floor(Date.now() / 1000), slot);
}

export function slotOwner(db: Database.Database, slot: number): string | null {
  const r = db.prepare("SELECT owner_id FROM teams_accounts WHERE slot=?").get(slot) as { owner_id: string } | undefined;
  return r?.owner_id ?? null;
}

export function claimSlot(db: Database.Database, userId: string, limits: { slotCount: number; perUser: number }): number {
  return db.transaction(() => {
    if (slotsOf(db, userId).length >= limits.perUser) throw new HttpError(409, `You can have at most ${limits.perUser} accounts`);
    const taken = new Set(listSlots(db).map((s) => s.slot));
    for (let n = 1; n <= limits.slotCount; n++) {
      if (taken.has(n)) continue;
      db.prepare("INSERT INTO teams_accounts(slot, owner_id, added) VALUES(?,?,?)").run(n, userId, Math.floor(Date.now() / 1000));
      return n;
    }
    throw new HttpError(409, `No free slot: all ${limits.slotCount} are in use`);
  }).immediate();
}

export function releaseSlot(db: Database.Database, slot: number) {
  db.prepare("DELETE FROM teams_accounts WHERE slot=?").run(slot);
}

export function savePushSubscription(db: Database.Database, userId: string, sub: Record<string, unknown>) {
  const endpoint = sub.endpoint;
  if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint)) throw new HttpError(400, "Subscription without endpoint");
  db.prepare("INSERT OR REPLACE INTO push_subscriptions(endpoint, user_id, sub, created) VALUES(?,?,?,?)").run(
    endpoint,
    userId,
    JSON.stringify(sub),
    Math.floor(Date.now() / 1000),
  );
}

export function countPushSubscriptions(db: Database.Database, userId: string): number {
  return (db.prepare("SELECT COUNT(*) FROM push_subscriptions WHERE user_id=?").pluck().get(userId) as number) ?? 0;
}

export function deletePushSubscriptionsOf(db: Database.Database, userId: string) {
  db.prepare("DELETE FROM push_subscriptions WHERE user_id=?").run(userId);
}
