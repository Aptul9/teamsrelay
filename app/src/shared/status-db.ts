import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// data/status.db: the status history of the status challenge (app/status-challenge-spec.md), apart from data/N/ so it
// outlives an account removed and added again. The light agents write it (src/agent/light/status.ts), the web app
// reads and deletes (src/lib/status-pages.ts); whichever opens it first creates it.

export const STATUSES = ["available", "busy", "dnd", "brb", "away", "offline"] as const;
export type Status = (typeof STATUSES)[number] | "unknown";

// Seconds after the last poll that saw a status within which the same status extends its stretch: 3 polls of the
// default LIGHT_POLL. The light agent uses 3 × its own poll.
export const STATUS_GAP = 180;

// presence.availability as Teams draws it next to the name
export function statusOf(availability: string): Status {
  switch (availability) {
    case "Available":
    case "AvailableIdle":
      return "available";
    case "Busy":
    case "BusyIdle":
      return "busy";
    case "DoNotDisturb":
      return "dnd";
    case "BeRightBack":
      return "brb";
    case "Away":
      return "away";
    case "Offline":
      return "offline";
    default:
      return "unknown";
  }
}

export function openStatusDb(file: string): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("busy_timeout = 8000");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS presence_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      mri TEXT NOT NULL,
      since INTEGER NOT NULL,
      until INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS presence_log_name ON presence_log(name, since);
  `);
  return db;
}

type Row = { id: number; since: number; until: number; status: Status };

const newest = (db: Database.Database, name: string) =>
  db.prepare("SELECT id, since, until, status FROM presence_log WHERE name=? ORDER BY since DESC, id DESC LIMIT 1").get(name) as Row | undefined;

// One poll: the same status as the newest stretch, seen at most `gap` seconds ago, extends it; anything else opens a
// stretch. A person the poll got no answer for is not in `seen`.
export function recordStatuses(db: Database.Database, seen: readonly { name: string; mri: string; status: Status }[], now: number, gap: number) {
  db.transaction(() => {
    for (const s of seen) {
      const last = newest(db, s.name);
      if (last && last.status === s.status && now - last.until <= gap) {
        if (now > last.until) db.prepare("UPDATE presence_log SET until=?, mri=? WHERE id=?").run(now, s.mri, last.id);
      } else {
        db.prepare("INSERT INTO presence_log(name, mri, since, until, status) VALUES(?,?,?,?,?)").run(s.name, s.mri, now, now, s.status);
      }
    }
  })();
}

// The stretches of a person that overlap [from, to), oldest first
export function stretchesOf(db: Database.Database, name: string, from: number, to: number): [number, number, Status][] {
  const rows = db.prepare("SELECT since, until, status FROM presence_log WHERE name=? AND since < ? AND until >= ? ORDER BY since, id").all(name, to, from) as Row[];
  return rows.map((r) => [r.since, r.until, r.status]);
}

export function newestOf(db: Database.Database, name: string): { since: number; until: number; status: Status } | null {
  const r = newest(db, name);
  return r ? { since: r.since, until: r.until, status: r.status } : null;
}

export function firstSince(db: Database.Database, name: string): number | null {
  return (db.prepare("SELECT MIN(since) FROM presence_log WHERE name=?").pluck().get(name) as number | null) ?? null;
}

export function deleteStatusesExcept(db: Database.Database, keep: readonly string[]): number {
  return db.prepare(`DELETE FROM presence_log WHERE name NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify(keep)).changes;
}

export function deleteStatusesOf(db: Database.Database, name: string): number {
  return db.prepare("DELETE FROM presence_log WHERE name=?").run(name).changes;
}
