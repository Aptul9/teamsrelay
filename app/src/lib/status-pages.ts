import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { nowSeconds } from "@/agent/context";
import { deleteStatusesOf, firstSince, newestOf, openStatusDb, STATUS_GAP, stretchesOf, type Status } from "@/shared/status-db";
import { config } from "./config";
import { dayOf, dayStart, dayStats, nextDay, type DayStats } from "./status-stats";

// The public status pages of the status challenge (app/status-challenge-spec.md): their rows in app.db, their history
// in data/status.db, and what /api/status/<slug> and the page answer.

export type StatusPage = { slug: string; slot: number; name: string; added: number; ends: number };

export const SLUG = /^[a-z0-9-]{2,32}$/;
// the data of a page is kept this long after its challenge ends, then the page goes too
export const KEPT_AFTER_END = 7 * 86400;
// paths Caddy takes before the web app (caddy/Caddyfile)
const CADDY_PATHS = ["desktop"];

// Every top-level entry of src/app and public, read at build time by next.config.ts (STATUS_RESERVED); tests and a
// development server read the folders
export function reservedSlugs(): Set<string> {
  const built = process.env.STATUS_RESERVED;
  const entries = built ? built.split(",") : ["src/app", "public"].flatMap((d) => fs.readdirSync(path.join(process.cwd(), d)));
  return new Set([...entries, ...CADDY_PATHS]);
}

// Why a slug cannot be a new page, null when it can
export function slugProblem(db: Database.Database, slug: string): { status: 400 | 409; reason: string } | null {
  if (!SLUG.test(slug)) return { status: 400, reason: "Path: 2 to 32 lowercase letters, digits or -" };
  if (reservedSlugs().has(slug)) return { status: 409, reason: `/${slug} is a page of TeamsRelay` };
  if (statusPageOf(db, slug)) return { status: 409, reason: `/${slug} is already a status page` };
  return null;
}

export const listStatusPages = (db: Database.Database) => db.prepare("SELECT slug, slot, name, added, ends FROM status_pages ORDER BY added, slug").all() as StatusPage[];

export const statusPageOf = (db: Database.Database, slug: string) =>
  (db.prepare("SELECT slug, slot, name, added, ends FROM status_pages WHERE slug=?").get(slug) as StatusPage | undefined) ?? null;

export function addStatusPage(db: Database.Database, p: StatusPage) {
  db.prepare("INSERT INTO status_pages(slug, slot, name, added, ends) VALUES(?,?,?,?,?)").run(p.slug, p.slot, p.name, p.added, p.ends);
}

export function setStatusPageEnds(db: Database.Database, slug: string, ends: number): boolean {
  return db.prepare("UPDATE status_pages SET ends=? WHERE slug=?").run(ends, slug).changes > 0;
}

// The page and, unless another page tracks the same person, its history
export function deleteStatusPage(db: Database.Database, sdb: Database.Database, slug: string): boolean {
  const page = statusPageOf(db, slug);
  if (!page) return false;
  db.prepare("DELETE FROM status_pages WHERE slug=?").run(slug);
  if (!db.prepare("SELECT 1 FROM status_pages WHERE name=?").get(page.name)) deleteStatusesOf(sdb, page.name);
  return true;
}

// Pages whose challenge ended more than 7 days ago, with their data
export function purgeEndedPages(db: Database.Database, sdb: Database.Database, now: number) {
  const ended = db.prepare("SELECT slug FROM status_pages WHERE ends > 0 AND ends + ? <= ?").pluck().all(KEPT_AFTER_END, now) as string[];
  for (const slug of ended) deleteStatusPage(db, sdb, slug);
}

export const statusDbFile = () => path.join(config.dataDir, "status.db");

const opened = new Map<string, Database.Database>();
export function statusDb(): Database.Database {
  const file = statusDbFile();
  let db = opened.get(file);
  if (!db) {
    db = openStatusDb(file);
    opened.set(file, db);
  }
  return db;
}

// The zone of the days and clock times of the challenge: the one of the container (TZ)
export const serverZone = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export type StatusDay = Omit<DayStats, "stretches"> & { stretches?: DayStats["stretches"] };
export type StatusAnswer = {
  name: string;
  now: { status: Status; since: number; fresh: boolean } | null;
  days: StatusDay[];
  ends: number;
  updated: number;
  zone: string;
};

// at most this many days in one answer, the newest
const MAX_DAYS = 400;

export function statusAnswer(db: Database.Database, slug: string, now = nowSeconds()): StatusAnswer | null {
  const sdb = statusDb();
  purgeEndedPages(db, sdb, now);
  const page = statusPageOf(db, slug);
  if (!page) return null;
  const zone = serverZone();
  const ended = page.ends > 0 && page.ends <= now;
  // an ended challenge shows its days up to the end
  const stop = ended ? page.ends : now;
  const last = dayOf(ended ? stop - 1 : stop, zone);
  const newest = newestOf(sdb, page.name);
  let day = dayOf(Math.min(page.added, firstSince(sdb, page.name) ?? page.added), zone);
  const days: string[] = [];
  for (; day <= last; day = nextDay(day)) days.push(day);
  const shown = days.slice(-MAX_DAYS);
  const stretches = stretchesOf(sdb, page.name, dayStart(shown[0] ?? last, zone), stop);
  return {
    name: page.name,
    now: newest ? { status: newest.status, since: newest.since, fresh: !ended && now - newest.until <= STATUS_GAP } : null,
    days: shown.map((d, i) => {
      const s = dayStats(stretches, d, { zone, now: stop, gap: STATUS_GAP });
      // the timeline draws today and yesterday; older days carry the totals only
      if (i < shown.length - 2) return { ...s, stretches: undefined };
      return s;
    }),
    ends: page.ends,
    updated: newest?.until ?? 0,
    zone,
  };
}
