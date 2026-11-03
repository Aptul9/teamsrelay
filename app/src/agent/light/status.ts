import type Database from "better-sqlite3";
import { STATE, StatusNames, parseState } from "@/shared/slot-db/state";
import { deleteStatusesExcept, openStatusDb, recordStatuses, statusOf, type StatusPageRow } from "@/shared/status-db";
import { errorText, log } from "../log";
import { HttpStatusError } from "./api";
import type { Light } from "./context";
import { SignedOut } from "./token";

export type { StatusPageRow };

// The status of the people the status pages of this account track, once per poll of the light agent, into
// data/status.db (app/status-challenge-spec.md, Collector)

const PAGES_EVERY_MS = 60_000;
const HOUR_MS = 3600_000;
// the data of a page is kept this long after its challenge ends
const KEPT_AFTER_END = 7 * 86400;

// What kind of failure a presence call had, logged once an hour each
function failureKind(e: unknown): string {
  if (e instanceof SignedOut) return "signed out";
  if (e instanceof HttpStatusError) return `HTTP ${e.status}`;
  return e instanceof Error ? e.name : "error";
}

// The mri of a person the account knows by this name: of the people named so far, else the other member of the 1:1
// chat of that name; "" for none
function mriOf(l: Light, name: string): string {
  const want = name.trim().toLowerCase();
  for (const [mri, p] of l.people) if (p.displayName.trim().toLowerCase() === want) return mri;
  for (const [chat, id] of l.list.ids) {
    const others = l.list.members.get(id);
    if (chat.trim().toLowerCase() === want && others?.length === 1) return others[0];
  }
  return "";
}

export class StatusCollector {
  private pages: { at: number; rows: StatusPageRow[] | null } = { at: -Infinity, rows: null };
  private db: Database.Database | null = null;
  private logged = new Map<string, number>();
  private retainedAt = -Infinity;

  constructor(private readonly o: { pages: () => StatusPageRow[] | null; file: string; slot: number; gap: number }) {}

  private once(key: string, message: string, nowMs: number) {
    if (nowMs - (this.logged.get(key) ?? -Infinity) < HOUR_MS) return;
    this.logged.set(key, nowMs);
    log.warn("status", message);
  }

  private open(): Database.Database {
    this.db ??= openStatusDb(this.o.file);
    return this.db;
  }

  // Rows of names no page tracks any more, and of pages ended more than 7 days ago; nothing while app.db is unreadable
  private retain(rows: StatusPageRow[] | null, now: number, nowMs: number) {
    if (!rows || nowMs - this.retainedAt < HOUR_MS) return;
    this.retainedAt = nowMs;
    const keep = [...new Set(rows.filter((p) => !p.ends || p.ends + KEPT_AFTER_END > now).map((p) => p.name))];
    const gone = deleteStatusesExcept(this.open(), keep);
    if (gone) log.info("status", "old status rows deleted", { rows: gone });
  }

  async poll(l: Light, nowMs = Date.now()): Promise<void> {
    try {
      await this.collect(l, nowMs);
    } catch (e) {
      this.once(`db:${failureKind(e)}`, `status not saved: ${errorText(e)}`, nowMs);
    }
  }

  private async collect(l: Light, nowMs: number) {
    if (nowMs - this.pages.at >= PAGES_EVERY_MS) this.pages = { at: nowMs, rows: this.o.pages() };
    const now = Math.floor(nowMs / 1000);
    const rows = this.pages.rows;
    this.retain(rows, now, nowMs);
    const names = [...new Set((rows ?? []).filter((p) => p.slot === this.o.slot && (!p.ends || p.ends > now)).map((p) => p.name))];
    if (!names.length) return;
    const found: StatusNames = Object.fromEntries(names.map((name) => [name, mriOf(l, name)]));
    if (JSON.stringify(parseState(StatusNames, l.store.getState(STATE.statusNames))) !== JSON.stringify(found)) {
      l.store.setState(STATE.statusNames, JSON.stringify(found));
    }
    for (const name of names) if (!found[name]) this.once(`name:${name}`, `status page person not found in this account: ${name}`, nowMs);
    const wanted = names.filter((name) => found[name]).map((name) => ({ name, mri: found[name] }));
    if (!wanted.length) return;
    let presence: Awaited<ReturnType<Light["api"]["presence"]>>;
    try {
      presence = await l.api.presence([...new Set(wanted.map((w) => w.mri))]);
    } catch (e) {
      this.once(`presence:${failureKind(e)}`, `status not read: ${errorText(e)}`, nowMs);
      return;
    }
    const seen = wanted.flatMap((w) => {
      const p = presence.get(w.mri);
      return p ? [{ ...w, status: statusOf(p.availability) }] : [];
    });
    if (seen.length) recordStatuses(this.open(), seen, now, this.o.gap);
  }
}
