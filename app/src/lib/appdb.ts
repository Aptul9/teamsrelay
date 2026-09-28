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
// check_every: seconds between two checks of an account whose browser runs only while it is checked, 0 for an account
// always on. check_due: when its next check is due, 0 once its owner asked for one. checked, check_result: end and
// outcome (ok, login, failed) of its last check, 0 and "" before the first. checking: start of the check running now.
// relay: 1 for an account on another computer, whose local relay joined this server with a token (src/lib/relay.ts);
// the supervisor has nothing of it.
export type Slot = {
  slot: number;
  owner_id: string;
  added: number;
  stopped: number;
  started: number;
  check_every: number;
  check_due: number;
  checked: number;
  check_result: string;
  checking: number;
  relay: number;
};

export { CHECK_INTERVALS } from "@/shared/checks";
export type CheckResult = "ok" | "login" | "failed";

// relay_token, the digest of the token of the relay, never leaves the database: rows say only whether there is one
const SLOT_COLUMNS = "slot, owner_id, added, stopped, started, check_every, check_due, checked, check_result, checking, (relay_token <> '') AS relay";

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
  for (const [column, decl] of [
    ["check_every", "INTEGER NOT NULL DEFAULT 0"],
    ["check_due", "INTEGER NOT NULL DEFAULT 0"],
    ["checked", "INTEGER NOT NULL DEFAULT 0"],
    ["check_result", "TEXT NOT NULL DEFAULT ''"],
    ["checking", "INTEGER NOT NULL DEFAULT 0"],
    // SHA-256 (hex) of the token of the relay of an account on another computer, "" for an account of the browsers container
    ["relay_token", "TEXT NOT NULL DEFAULT ''"],
  ]) {
    if (!columns.includes(column)) db.exec(`ALTER TABLE teams_accounts ADD COLUMN ${column} ${decl}`);
  }
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
  return db.prepare(`SELECT ${SLOT_COLUMNS} FROM teams_accounts ORDER BY slot`).all() as Slot[];
}

export function slotsOf(db: Database.Database, userId: string): Slot[] {
  return db.prepare(`SELECT ${SLOT_COLUMNS} FROM teams_accounts WHERE owner_id=? ORDER BY slot`).all(userId) as Slot[];
}

export function slotRow(db: Database.Database, slot: number): Slot | null {
  return (db.prepare(`SELECT ${SLOT_COLUMNS} FROM teams_accounts WHERE slot=?`).get(slot) as Slot | undefined) ?? null;
}

// Always on (0) or checked every `every` seconds, the first check one interval from now
export function setCheckEvery(db: Database.Database, slot: number, every: number, now: number) {
  db.prepare("UPDATE teams_accounts SET check_every=?, check_due=? WHERE slot=?").run(every, every ? now + every : 0, slot);
}

// A check asked by the owner: due at once, before the ones due by time
export function askCheck(db: Database.Database, slot: number) {
  db.prepare("UPDATE teams_accounts SET check_due=0 WHERE slot=?").run(slot);
}

export function beginCheck(db: Database.Database, slot: number, now: number) {
  db.prepare("UPDATE teams_accounts SET checking=? WHERE slot=?").run(now, slot);
}

// A check that ended: its time and outcome, and the next one an interval later, unless its owner asked for one while
// it ran (asked: this check was the one asked). result null: cut short (the account stopped, removed or set back to
// always on meanwhile), nothing recorded.
export function endCheck(db: Database.Database, slot: number, { now, result, asked = false }: { now: number; result: CheckResult | null; asked?: boolean }) {
  if (!result) return db.prepare("UPDATE teams_accounts SET checking=0 WHERE slot=?").run(slot);
  db.prepare(
    "UPDATE teams_accounts SET checking=0, checked=?, check_result=?, check_due=CASE WHEN check_due = 0 AND NOT ? THEN 0 WHEN check_every > 0 THEN ? + check_every ELSE 0 END WHERE slot=?",
  ).run(now, result, asked ? 1 : 0, now, slot);
}

// The checked account in service whose check is due first, asked ones before
export function nextCheck(db: Database.Database, now: number): Slot | null {
  return (
    (db
      .prepare(`SELECT ${SLOT_COLUMNS} FROM teams_accounts WHERE check_every > 0 AND stopped = 0 AND check_due <= ? ORDER BY check_due, slot LIMIT 1`)
      .get(now) as Slot | undefined) ?? null
  );
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

// The account of the relay that holds the token of this digest
export function setRelayToken(db: Database.Database, slot: number, digest: string) {
  db.prepare("UPDATE teams_accounts SET relay_token=? WHERE slot=?").run(digest, slot);
}

export function relayAccount(db: Database.Database, digest: string): { slot: number; added: number; owner_id: string } | null {
  if (!digest) return null;
  return (db.prepare("SELECT slot, added, owner_id FROM teams_accounts WHERE relay_token=?").get(digest) as { slot: number; added: number; owner_id: string } | undefined) ?? null;
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
