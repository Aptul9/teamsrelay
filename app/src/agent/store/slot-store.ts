import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { CommandStatus, CommandType } from "@/shared/slot-db/commands";
import { HAS_TEAMS_ID, type Message, type MessageExtra, type ReadBy } from "@/shared/slot-db/rows";
import { CALL_LOG_SIZE, ensureSlotSchema } from "@/shared/slot-db/schema";
import { Identity, parseState, STATE } from "@/shared/slot-db/state";
import { nowSeconds } from "../context";
import { mergeChats, type ChatEntry } from "../logic/chats";

// The agent side of data/N/messages.db (src/shared/slot-db), or of relay.db for the local relay, where the API
// reads it and queues commands through the same connection: one connection for the life of the process.

// ts: when the app queued it (Unix seconds)
export type PendingCommand = { id: number; type: string; arg1: string; arg2: string; ts?: number };
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
    const rows = this.db.prepare("SELECT name, preview, tm, unread, mention, muted, av, presence, kind FROM chats ORDER BY pos").all() as {
      name: string;
      preview: string | null;
      tm: string | null;
      unread: number | null;
      mention: number | null;
      muted: number | null;
      av: string | null;
      presence: string | null;
      kind: string | null;
    }[];
    return rows.map((r) => ({
      name: r.name,
      preview: r.preview ?? "",
      time: r.tm ?? "",
      unread: !!r.unread,
      mention: !!r.mention,
      muted: !!r.muted,
      av: r.av ?? "",
      presence: r.presence ?? "",
      kind: r.kind ?? "",
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
        "INSERT OR REPLACE INTO chats(name, preview, pos, ts, tm, unread, mention, muted, av, presence, kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      );
      rows.forEach((c, i) => insert.run(c.name, c.preview, i, ts, c.time, bit(c.unread), bit(c.mention), bit(c.muted), c.av, c.presence ?? "", c.kind ?? ""));
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

  // Files of the media folder the rows name (mediaFilesOf)
  mediaFiles(): Set<string> {
    return mediaFilesOf(this.db);
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

  // Messages of a chat as saved the last time it was open in Teams
  messages(chat: string): Message[] {
    const rows = this.db.prepare("SELECT mid, author, text, mine, reacts, extra FROM chat_messages WHERE chat=? ORDER BY idx").all(chat) as (Message & {
      extra: string | null;
    })[];
    return rows.map(({ extra, ...m }) => ({ ...m, ...parseExtra(extra) }));
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

  // A command with a key already queued is not queued again: the id of the first one comes back. ts: when it was
  // queued, where the relay of an account on another computer takes it from the server
  enqueue(type: CommandType, arg1 = "", arg2 = "", key: string | null = null, ts = nowSeconds()): number {
    const known = key ? this.commandIdByKey(key) : null;
    if (known) return known;
    const r = this.db.prepare("INSERT INTO commands(ts, type, arg1, arg2, key) VALUES(?,?,?,?,?)").run(ts, type, arg1, arg2, key);
    return Number(r.lastInsertRowid);
  }

  commandIdByKey(key: string): number | null {
    const r = this.db.prepare("SELECT id FROM commands WHERE key=?").get(key) as { id: number } | undefined;
    return r?.id ?? null;
  }

  commandStatus(id: number): CommandStatus | null {
    const r = this.db.prepare("SELECT status FROM commands WHERE id=?").get(id) as { status: CommandStatus } | undefined;
    return r?.status ?? null;
  }

  pendingCommands(): PendingCommand[] {
    return this.db
      .prepare("SELECT id, type, COALESCE(arg1, '') AS arg1, COALESCE(arg2, '') AS arg2, COALESCE(ts, 0) AS ts FROM commands WHERE status='pending' ORDER BY id")
      .all() as PendingCommand[];
  }

  hasPendingCommands(): boolean {
    return !!this.db.prepare("SELECT 1 FROM commands WHERE status='pending' LIMIT 1").get();
  }

  // The agent takes the command: from here on a stop of the agent leaves it running, never pending again
  startCommand(id: number) {
    this.db.prepare("UPDATE commands SET status='running' WHERE id=? AND status='pending'").run(id);
  }

  finishCommand(id: number, status: Exclude<CommandStatus, "pending" | "running">) {
    this.db.prepare("UPDATE commands SET status=? WHERE id=?").run(status, id);
  }

  // Commands left running by an agent that stopped (restart, crash) may have reached Teams: a send may be out, a
  // reaction set. They end as unconfirmed, never run again. Number of commands.
  interruptedCommands(): number {
    return this.db.prepare("UPDATE commands SET status='unconfirmed' WHERE status='running'").run().changes;
  }

  // Commands still waiting after `maxAge` seconds end as failed: a message queued while Teams was signed out or the
  // agent was down must not go out minutes later, when nobody expects it any more. Number of commands expired.
  expirePendingCommands(maxAge: number, now = nowSeconds()): number {
    return this.db.prepare("UPDATE commands SET status='failed' WHERE status='pending' AND ts < ?").run(now - maxAge).changes;
  }

  // A call that rang, for the call log of the web app: the last CALL_LOG_SIZE are kept
  addCall(caller: string, since: number, seconds: number) {
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO calls(since, caller, seconds) VALUES(?, ?, ?)").run(since, caller, seconds);
      this.db.prepare("DELETE FROM calls WHERE id NOT IN (SELECT id FROM calls ORDER BY since DESC, id DESC LIMIT ?)").run(CALL_LOG_SIZE);
    })();
  }

  // Ids of every item of the Activity feed, in feed order (newest first)
  activityIds(): string[] {
    return this.db.prepare("SELECT id FROM activity ORDER BY pos").pluck().all() as string[];
  }

  // Ids of the items with their Teams id the Activity feed shows unread (bold), in feed order
  unreadActivity(): string[] {
    return this.db.prepare(`SELECT id FROM activity WHERE unread=1 AND ${HAS_TEAMS_ID} ORDER BY pos`).pluck().all() as string[];
  }

  // Every missed call of the feed that has its Teams id, in feed order: who called, and the time Teams shows. Teams
  // shows them as read (not bold), new or not: the check tells a new one by its id (commands/check.ts).
  missedCalls(): { id: string; caller: string; time: string }[] {
    return this.db.prepare(`SELECT id, actor AS caller, tm AS time FROM activity WHERE kind='call' AND ${HAS_TEAMS_ID} ORDER BY pos`).all() as {
      id: string;
      caller: string;
      time: string;
    }[];
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

// Files of the media folder the rows of a slot database name: pictures of the chats, of the feed and of the account,
// images and pictures of the messages kept (a chat that left the list keeps the last ones). No other file of the folder
// shows anywhere. The web app reads them in the database of an account on another computer (src/lib/relay.ts).
export function mediaFilesOf(db: Database.Database): Set<string> {
  const files = new Set<string>();
  const add = (f: unknown) => {
    if (typeof f === "string" && f) files.add(f);
  };
  for (const av of db.prepare("SELECT av FROM chats UNION SELECT av FROM activity").pluck().all()) add(av);
  for (const v of db.prepare("SELECT extra FROM chat_messages").pluck().all() as (string | null)[]) {
    const extra = parseExtra(v);
    add(extra.av);
    for (const im of Array.isArray(extra.images) ? extra.images : []) add(im?.f);
  }
  add(parseState(Identity, db.prepare("SELECT v FROM state WHERE k=?").pluck().get(STATE.me) as string | null | undefined, null)?.av);
  return files;
}

function parseExtra(v: string | null): MessageExtra {
  if (!v) return {};
  try {
    const extra: unknown = JSON.parse(v);
    return extra && typeof extra === "object" ? (extra as MessageExtra) : {};
  } catch {
    return {};
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
