import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { CommandStatus } from "@/shared/slot-db/commands";
import type { MessageExtra, ReadBy } from "@/shared/slot-db/rows";
import { ensureSlotSchema } from "@/shared/slot-db/schema";
import { mergeChats, type ChatEntry } from "../logic/chats";

// The agent side of data/N/messages.db (src/shared/slot-db): one connection for the life of the agent.

export type PendingCommand = { id: number; type: string; arg1: string; arg2: string };
export type SavedMessage = { mid: string; author: string; text: string; mine: boolean; reacts: string; extra: MessageExtra | null };
export type ActivityEntry = {
  id: string;
  kind: string;
  actor: string;
  title: string;
  emoji: string;
  preview: string;
  tm: string;
  chat: string;
  channel: boolean;
  unread: boolean;
  av: string;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const bit = (v: boolean) => (v ? 1 : 0);

export class SlotStore {
  private constructor(private readonly db: Database.Database) {}

  static open(file: string): SlotStore {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    // the web app reads and queues commands at the same time: wait for its locks like the Python agent (8 s)
    db.pragma("busy_timeout = 8000");
    ensureSlotSchema(db);
    return new SlotStore(db);
  }

  close() {
    this.db.close();
  }

  getState(key: string): string {
    const r = this.db.prepare("SELECT v FROM state WHERE k=?").get(key) as { v: string | null } | undefined;
    return r?.v ?? "";
  }

  setState(key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)").run(key, value);
  }

  // History of the notifications sent, shown by the web app (/api/feed)
  addNotification(title: string, body: string) {
    this.db.prepare("INSERT INTO messages(ts, source, title, body) VALUES(?, 'teams', ?, ?)").run(nowSeconds(), title, body);
  }

  lastNotificationTs(): number {
    const r = this.db.prepare("SELECT ts FROM messages ORDER BY id DESC LIMIT 1").get() as { ts: number } | undefined;
    return r?.ts ?? 0;
  }

  chats(): ChatEntry[] {
    const rows = this.db.prepare("SELECT name, preview, tm, unread, mention, muted, av FROM chats ORDER BY pos").all() as {
      name: string;
      preview: string | null;
      tm: string | null;
      unread: number | null;
      mention: number | null;
      muted: number | null;
      av: string | null;
    }[];
    return rows.map((r) => ({
      name: r.name,
      preview: r.preview ?? "",
      time: r.tm ?? "",
      unread: !!r.unread,
      mention: !!r.mention,
      muted: !!r.muted,
      av: r.av ?? "",
    }));
  }

  // One transaction: the web app never sees the list empty
  saveChats(visible: readonly ChatEntry[], replace = false) {
    if (!visible.length) return;
    this.db.transaction(() => {
      const rows = mergeChats(visible, this.chats(), replace);
      const ts = nowSeconds();
      this.db.prepare("DELETE FROM chats").run();
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO chats(name, preview, pos, ts, tm, unread, mention, muted, av) VALUES(?,?,?,?,?,?,?,?,?)",
      );
      rows.forEach((c, i) => insert.run(c.name, c.preview, i, ts, c.time, bit(c.unread), bit(c.mention), bit(c.muted), c.av));
    })();
  }

  isKnownChat(name: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM chats WHERE name=?").get(name);
  }

  // The chat with yourself ("Name (You)"): the visible page can read nothing there on the user's behalf
  selfChat(): string {
    const r = this.db.prepare("SELECT name FROM chats WHERE name LIKE '%(You)%' ORDER BY pos LIMIT 1").get() as { name: string } | undefined;
    return r?.name ?? "";
  }

  saveChatMessages(chat: string, messages: readonly SavedMessage[]) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM chat_messages WHERE chat=?").run(chat);
      const insert = this.db.prepare("INSERT INTO chat_messages(chat, idx, mid, author, text, mine, reacts, extra) VALUES(?,?,?,?,?,?,?,?)");
      messages.forEach((m, i) =>
        insert.run(chat, i, m.mid, m.author, m.text, bit(m.mine), m.reacts, m.extra ? JSON.stringify(m.extra) : ""),
      );
    })();
  }

  ownRecentMessageIds(chat: string, limit: number): string[] {
    return this.db
      .prepare("SELECT mid FROM chat_messages WHERE chat=? AND mine=1 AND mid<>'' ORDER BY idx DESC LIMIT ?")
      .pluck()
      .all(chat, limit) as string[];
  }

  readByOf(chat: string): Map<string, { label: string; ts: number }> {
    const rows = this.db.prepare("SELECT mid, label, ts FROM readby WHERE chat=?").all(chat) as { mid: string; label: string; ts: number }[];
    return new Map(rows.map((r) => [r.mid, { label: r.label ?? "", ts: r.ts ?? 0 }]));
  }

  readByCache(mids: readonly string[]): Map<string, ReadBy> {
    if (!mids.length) return new Map();
    const rows = this.db
      .prepare(`SELECT mid, label, names FROM readby WHERE mid IN (${mids.map(() => "?").join(",")})`)
      .all(...mids) as { mid: string; label: string; names: string | null }[];
    return new Map(rows.map((r) => [r.mid, { label: r.label ?? "", names: parseNames(r.names) }]));
  }

  saveReadBy(mid: string, chat: string, readBy: ReadBy) {
    this.db
      .prepare("INSERT OR REPLACE INTO readby(mid, chat, label, names, ts) VALUES(?,?,?,?,?)")
      .run(mid, chat, readBy.label, JSON.stringify(readBy.names), nowSeconds());
  }

  pendingCommands(): PendingCommand[] {
    return this.db
      .prepare("SELECT id, type, COALESCE(arg1, '') AS arg1, COALESCE(arg2, '') AS arg2 FROM commands WHERE status='pending' ORDER BY id")
      .all() as PendingCommand[];
  }

  hasPendingCommands(): boolean {
    return !!this.db.prepare("SELECT 1 FROM commands WHERE status='pending' LIMIT 1").get();
  }

  finishCommand(id: number, status: Exclude<CommandStatus, "pending">) {
    this.db.prepare("UPDATE commands SET status=? WHERE id=?").run(status, id);
  }

  saveActivity(items: readonly ActivityEntry[]) {
    this.db.transaction(() => {
      const ts = nowSeconds();
      this.db.prepare("DELETE FROM activity").run();
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO activity(id, pos, kind, actor, title, emoji, preview, tm, chat, channel, unread, ts, av) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      items.forEach((a, i) =>
        insert.run(a.id || `x${i}`, i, a.kind, a.actor, a.title, a.emoji, a.preview, a.tm, a.chat, bit(a.channel), bit(a.unread), ts, a.av),
      );
    })();
  }
}

function parseNames(v: string | null): string[] {
  try {
    const names: unknown = JSON.parse(v || "[]");
    return Array.isArray(names) ? names.map(String) : [];
  } catch {
    return [];
  }
}
