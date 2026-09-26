import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config";

// data/N/messages.db is created and written by the agent of slot N; the web app reads it and
// queues commands in it. Opening it must never create an empty file.

export class SlotNotReady extends Error {
  constructor() {
    super("Account not ready yet");
  }
}

export type Chat = { name: string; preview: string; tm: string; unread: number; mention: number; muted: number; av: string };
export type Message = { mid: string; author: string; text: string; mine: number; reacts: string } & Record<string, unknown>;
export type ActivityItem = Record<string, unknown>;
export type Health = Record<string, unknown> & { agent?: string; teams?: string; overall?: string; ts?: number };
export type CommandStatus = { status: string; result: unknown };

export function slotDbPath(slot: number): string {
  return path.join(config.dataDir, String(slot), "messages.db");
}

export function slotDir(slot: number): string {
  return path.join(config.dataDir, String(slot));
}

function parse<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export class SlotReader {
  private constructor(private db: Database.Database) {}

  static open(file: string): SlotReader {
    if (!fs.existsSync(file)) throw new SlotNotReady();
    const db = new Database(file, { fileMustExist: true });
    db.pragma("busy_timeout = 8000");
    return new SlotReader(db);
  }

  static forSlot(slot: number): SlotReader {
    return SlotReader.open(slotDbPath(slot));
  }

  close() {
    this.db.close();
  }

  // A table the agent has not created yet reads as empty, like the previous web app did.
  private all<T>(sql: string, ...args: unknown[]): T[] {
    try {
      return this.db.prepare(sql).all(...args) as T[];
    } catch {
      return [];
    }
  }

  state<T>(key: string, fallback: T): T {
    const r = this.all<{ v: string }>("SELECT v FROM state WHERE k=?", key)[0];
    return parse(r?.v, fallback);
  }

  chats(): Chat[] {
    return this.all<Chat>("SELECT name, preview, tm, unread, mention, muted, av FROM chats ORDER BY pos").map((c) => ({
      ...c,
      muted: c.muted ?? 0,
      av: c.av ?? "",
    }));
  }

  messages(chat: string): Message[] {
    return this.all<Message & { extra: string }>(
      "SELECT mid, author, text, mine, reacts, extra FROM chat_messages WHERE chat=? ORDER BY idx",
      chat,
    ).map(({ extra, ...m }) => ({ ...m, ...parse<Record<string, unknown>>(extra, {}) }));
  }

  activity(): { ts: number; items: ActivityItem[] } {
    return {
      ts: Number(this.state("activity_ts", 0)) || 0,
      items: this.all("SELECT id, kind, actor, title, emoji, preview, tm, chat, channel, unread, av FROM activity ORDER BY pos"),
    };
  }

  feed() {
    return this.all("SELECT id, ts, title, body FROM messages ORDER BY id DESC LIMIT 150");
  }

  identity(): { name?: string; email?: string; tenant?: string; av?: string } {
    return this.state("me", {});
  }

  unreadCount(): number {
    const r = this.all<{ c: number }>(
      "SELECT COUNT(*) AS c FROM chats WHERE unread=1 AND COALESCE(muted,0)=0 AND name NOT LIKE '%(You)%'",
    )[0];
    return r?.c ?? 0;
  }

  health(added: number): Health {
    return healthOf(this.state("health", {}), added);
  }

  commandStatus(id: number): CommandStatus | null {
    const r = this.all<{ status: string }>("SELECT status FROM commands WHERE id=?", id)[0];
    if (!r) return null;
    return { status: r.status, result: this.state<unknown>(`cmd_result:${id}`, null) };
  }

  enqueue(type: string, arg1 = "", arg2 = ""): number {
    const r = this.db
      .prepare("INSERT INTO commands(ts, type, arg1, arg2) VALUES(?,?,?,?)")
      .run(Math.floor(Date.now() / 1000), type, arg1, arg2);
    return Number(r.lastInsertRowid);
  }
}

// The agent rewrites its health every ~5 s. Older than a minute, it no longer describes reality.
export function healthOf(saved: Health, added: number): Health {
  const h: Health = { ...saved };
  const now = Date.now() / 1000;
  const age = now - (Number(h.ts) || 0);
  h.agent = age < 60 ? "ok" : "stale";
  if (h.agent !== "ok") {
    // a slot just switched on needs up to a couple of minutes for browser and agent
    const starting = now - (added || 0) < 180;
    Object.assign(h, { teams: starting ? "starting" : "unknown", watcher: "stale", overall: starting ? "yellow" : "red" });
  }
  h.overall ??= "yellow";
  return h;
}

// Opens the slot database for the duration of one call.
export function withSlot<T>(slot: number, fn: (r: SlotReader) => T): T {
  const r = SlotReader.forSlot(slot);
  try {
    return fn(r);
  } finally {
    r.close();
  }
}
