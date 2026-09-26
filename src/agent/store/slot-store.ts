import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { CommandStatus, CommandType } from "@/shared/slot-db/commands";
import type { Message, MessageExtra } from "@/shared/slot-db/rows";
import { ensureSlotSchema } from "@/shared/slot-db/schema";
import { mergeChats, type ChatEntry } from "../logic/chats";

// state/relay.db (src/shared/slot-db): one connection for the life of the relay, shared by the agent and the API.

export type PendingCommand = { id: number; type: string; arg1: string; arg2: string };
export type SavedMessage = { mid: string; author: string; text: string; mine: boolean; reacts: string; extra: MessageExtra | null };
export type PushTarget = { endpoint: string; sub: string };

const nowSeconds = () => Math.floor(Date.now() / 1000);
const bit = (v: boolean) => (v ? 1 : 0);

export class SlotStore {
  private constructor(private readonly db: Database.Database) {}

  static open(file: string): SlotStore {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
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

  // History of the notifications sent
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

  // One transaction: the app never sees the list empty
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

  // Messages of a chat as saved the last time it was open in Teams
  messages(chat: string): Message[] {
    const rows = this.db.prepare("SELECT mid, author, text, mine, reacts, extra FROM chat_messages WHERE chat=? ORDER BY idx").all(chat) as (Message & {
      extra: string | null;
    })[];
    return rows.map(({ extra, ...m }) => ({ ...m, ...parseExtra(extra) }));
  }

  enqueue(type: CommandType, arg1 = "", arg2 = ""): number {
    const r = this.db.prepare("INSERT INTO commands(ts, type, arg1, arg2) VALUES(?,?,?,?)").run(nowSeconds(), type, arg1, arg2);
    return Number(r.lastInsertRowid);
  }

  commandStatus(id: number): CommandStatus | null {
    const r = this.db.prepare("SELECT status FROM commands WHERE id=?").get(id) as { status: CommandStatus } | undefined;
    return r?.status ?? null;
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

  // Commands still waiting after `maxAge` seconds end as failed: a message queued while Teams was signed out or the
  // browser was down must not go out hours later, when nobody expects it any more. Number of commands expired.
  expirePendingCommands(maxAge: number, now = nowSeconds()): number {
    return this.db.prepare("UPDATE commands SET status='failed' WHERE status='pending' AND ts < ?").run(now - maxAge).changes;
  }

  pushSubscriptions(): PushTarget[] {
    return this.db.prepare("SELECT endpoint, sub FROM push_subscriptions ORDER BY ts").all() as PushTarget[];
  }

  pushSubscriptionCount(): number {
    return this.db.prepare("SELECT COUNT(*) FROM push_subscriptions").pluck().get() as number;
  }

  // A device subscribing again replaces its subscription
  savePushSubscription(endpoint: string, sub: string, ua: string) {
    this.db.prepare("INSERT OR REPLACE INTO push_subscriptions(endpoint, sub, ua, ts) VALUES(?,?,?,?)").run(endpoint, sub, ua, nowSeconds());
  }

  deletePushSubscription(endpoint: string): boolean {
    return this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").run(endpoint).changes > 0;
  }
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
