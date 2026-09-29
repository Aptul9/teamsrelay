import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { OpenResult, type CommandType, type OpenStatus } from "@/shared/slot-db/commands";
import { HAS_TEAMS_ID, type ActivityItem, type CallLogEntry, type Chat, type Message, type MessageExtra } from "@/shared/slot-db/rows";
import { CALL_LOG_SIZE } from "@/shared/slot-db/schema";
import { CallState, cmdResultKey, InCall, Members, membersKey, parseState, STATE, type SlotHealth } from "@/shared/slot-db/state";
import { config } from "./config";

// data/N/messages.db is created and written by the agent of slot N; the web app reads it and
// queues commands in it. Opening it must never create an empty file.

export class SlotNotReady extends Error {
  constructor() {
    super("Account not ready yet");
  }
}

export type Health = SlotHealth;
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

  // Chat the agent last opened for the app, plain text: Teams shows it while it is in use (viewing)
  activeChat(): string {
    return this.all<{ v: string }>("SELECT v FROM state WHERE k=?", STATE.activeChat)[0]?.v ?? "";
  }

  chats(): Chat[] {
    return this.all<Chat>("SELECT name, preview, tm, unread, mention, muted, av, presence FROM chats ORDER BY pos").map((c) => ({
      ...c,
      muted: c.muted ?? 0,
      av: c.av ?? "",
      presence: c.presence ?? "",
    }));
  }

  messages(chat: string): Message[] {
    return this.all<Message & { extra: string }>(
      "SELECT mid, author, text, mine, reacts, extra FROM chat_messages WHERE chat=? ORDER BY idx",
      chat,
    ).map(({ extra, ...m }) => ({ ...m, ...parse<MessageExtra>(extra, {}) }));
  }

  activity(): { ts: number; items: ActivityItem[] } {
    return {
      ts: Number(this.state(STATE.activityTs, 0)) || 0,
      items: this.all<ActivityItem>("SELECT id, kind, actor, title, emoji, preview, tm, chat, channel, unread, av FROM activity ORDER BY pos"),
    };
  }

  feed() {
    return this.all("SELECT id, ts, title, body FROM messages ORDER BY id DESC LIMIT 150");
  }

  identity(): { name?: string; email?: string; tenant?: string; av?: string } {
    return this.state(STATE.me, {});
  }

  // People of a chat as the agent read them last; ts 0 when never read
  members(chat: string): Members {
    return Members.parse(this.state<unknown>(membersKey(chat), {}) ?? {});
  }

  // Command of this type and first argument still waiting for the agent, or running: its id, 0 when there is none
  pendingCommand(type: CommandType, arg1: string): number {
    return (
      this.all<{ id: number }>("SELECT id FROM commands WHERE type=? AND arg1=? AND status IN ('pending','running') ORDER BY id DESC LIMIT 1", type, arg1)[0]?.id ?? 0
    );
  }

  unreadCount(): number {
    const r = this.all<{ c: number }>(
      "SELECT COUNT(*) AS c FROM chats WHERE unread=1 AND COALESCE(muted,0)=0 AND name NOT LIKE '%(You)%'",
    )[0];
    return r?.c ?? 0;
  }

  // Ids of the items Teams shows bold in the Activity feed, in feed order; null until the agent has saved the feed once
  // (it saves none while the feed is empty)
  unreadActivity(): string[] | null {
    if (!Number(this.state(STATE.activityTs, 0))) return null;
    return this.all<{ id: string }>(`SELECT id FROM activity WHERE unread=1 AND ${HAS_TEAMS_ID} ORDER BY pos`).map((r) => r.id);
  }

  // Ids of every missed call of the feed that has its Teams id, in feed order, null until the agent has saved the feed
  // once. Teams shows a missed call as read (not bold), new or not: a device tells a new one by an id it has not shown.
  missedCalls(): string[] | null {
    if (!Number(this.state(STATE.activityTs, 0))) return null;
    return this.all<{ id: string }>(`SELECT id FROM activity WHERE kind='call' AND ${HAS_TEAMS_ID} ORDER BY pos`).map((r) => r.id);
  }

  // Ids of every item of the feed, newest first, null likewise: what a device meeting the account takes as seen
  activityIds(): string[] | null {
    if (!Number(this.state(STATE.activityTs, 0))) return null;
    return this.all<{ id: string }>("SELECT id FROM activity ORDER BY pos").map((r) => r.id);
  }

  // The incoming call as the agent keeps it, null before the first one
  call(): CallState | null {
    const v = this.all<{ v: string }>("SELECT v FROM state WHERE k=?", STATE.call)[0]?.v;
    return v ? parseState(CallState, v, null) : null;
  }

  // The call in progress as the agent keeps it, null before the first one
  inCall(): InCall | null {
    const v = this.all<{ v: string }>("SELECT v FROM state WHERE k=?", STATE.inCall)[0]?.v;
    return v ? parseState(InCall, v, null) : null;
  }

  // The calls the agent saw ring, newest first
  callLog(): CallLogEntry[] {
    return this.all<CallLogEntry>(`SELECT caller, since, seconds FROM calls ORDER BY since DESC, id DESC LIMIT ${CALL_LOG_SIZE}`);
  }

  health(added: number): Health {
    return healthOf(this.state(STATE.health, {}), added);
  }

  // pending, done or failed, as the API always answered: running is still pending for the app, unconfirmed (the agent
  // stopped while it ran) is not done
  commandStatus(id: number): CommandStatus | null {
    const r = this.all<{ status: string }>("SELECT status FROM commands WHERE id=?", id)[0];
    if (!r) return null;
    return { status: appStatus(r.status), result: this.state<unknown>(cmdResultKey(id), null) };
  }

  // The last open of the chat, as the app follows it (OpenStatus); null before the first. The event stream reads it
  // before the messages: an open read done comes with messages saved no earlier than its own.
  openOf(chat: string): OpenStatus | null {
    const r = this.all<{ id: number; status: string }>("SELECT id, status FROM commands WHERE type='open' AND arg1=? ORDER BY id DESC LIMIT 1", chat)[0];
    if (!r) return null;
    const status = appStatus(r.status) as OpenStatus["status"];
    if (status !== "failed") return { id: r.id, status };
    const why = OpenResult.safeParse(this.state<unknown>(cmdResultKey(r.id), null));
    return why.success ? { id: r.id, status, reason: why.data.reason } : { id: r.id, status };
  }

  enqueue(type: CommandType, arg1 = "", arg2 = ""): number {
    const r = this.db
      .prepare("INSERT INTO commands(ts, type, arg1, arg2) VALUES(?,?,?,?)")
      .run(Math.floor(Date.now() / 1000), type, arg1, arg2);
    return Number(r.lastInsertRowid);
  }

  // The same command still waiting for the agent, else a new one: a tap sent twice queues it once, a try after one that
  // ended queues it again
  enqueueOnce(type: CommandType, arg1 = "", arg2 = ""): number {
    return this.db.transaction(() => {
      const waiting = this.all<{ id: number }>("SELECT id FROM commands WHERE status='pending' AND type=? AND arg1=? AND arg2=? ORDER BY id LIMIT 1", type, arg1, arg2)[0];
      return waiting ? waiting.id : this.enqueue(type, arg1, arg2);
    })();
  }

  // What the last check of the account found (checked every N hours): forgotten, the next check only records what it
  // finds and pushes nothing from before
  forgetLastCheck() {
    this.db.prepare("DELETE FROM state WHERE k=?").run(STATE.checkSeen);
  }

  // The app shows this chat now. Teams keeps a visible page, which reads what is open: without a recent mark
  // the agent goes back to the self chat (wantedChat in src/agent/logic/parking.ts).
  markViewing(chat: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)")
      .run(STATE.viewing, JSON.stringify({ chat, ts: Math.floor(Date.now() / 1000) }));
  }

  // The owner opens the remote desktop of the account: its agent leaves Teams as it is for a while
  // (src/agent/logic/owner.ts)
  markDesktop() {
    this.db.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)").run(STATE.desktop, JSON.stringify({ ts: Math.floor(Date.now() / 1000) }));
  }
}

const appStatus = (s: string) => (s === "running" ? "pending" : s === "unconfirmed" ? "failed" : s);

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
