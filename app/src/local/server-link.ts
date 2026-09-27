import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type webpush from "web-push";
import { errorText, log } from "@/agent/log";
import type { Notify } from "@/agent/push/notifier";
import type { SlotStore } from "@/agent/store/slot-store";
import {
  COMMANDS_WAIT_MS,
  SERVER_COMMAND_KEY,
  serverCommandKey,
  type ActivityRow,
  type CallRow,
  type ChatRow,
  type CommandsAnswer,
  type HaveBody,
  type MessageRow,
  type PushBody,
  type ReadByRow,
  type ServerCommand,
  type SyncBody,
} from "@/shared/relay-sync";
import { ImageArgs, parseArgs, UPLOAD_NAME, type CommandStatus, type CommandType } from "@/shared/slot-db/commands";
import { FILE_NAME, MEDIA_NAME } from "@/shared/slot-db/rows";
import { cmdResultKey, parseState, STATE, Viewing } from "@/shared/slot-db/state";

// The relay of an account on another computer, joined to a TeamsRelay server (docs/design/2026-09-27-relay-joins-
// server.md): relay.db mirrored into data/N/messages.db of the server, the commands the app queues there run here,
// the notifications sent by the server. The relay opens every connection; the server never reaches this computer.

// About 4 MB of messages per sync: the chats left over go at the next one
const MESSAGES_PER_SYNC = 4e6;
const SYNC_EVERY_MS = 1000;
const digest = (v: unknown) => crypto.createHash("sha1").update(JSON.stringify(v)).digest("base64");

export class ServerError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(
      status === 401
        ? "token refused (401): the account was removed from the server or got a new token, set SERVER_TOKEN"
        : `HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
}

// What the server has taken, by digest: what changed since goes in the next sync
type Sent = {
  chats: string;
  activity: string;
  calls: string;
  messages: Map<string, string>;
  state: Map<string, string>;
  readby: Map<string, string>;
  commands: Map<number, string>;
};
const nothingSent = (): Sent => ({ chats: "", activity: "", calls: "", messages: new Map(), state: new Map(), readby: new Map(), commands: new Map() });

export type ServerLinkOptions = {
  url: string;
  token: string;
  // name of this computer, shown by the app (HOST_LABEL)
  host: string;
  dbPath: string;
  store: SlotStore;
  mediaDir: string;
  filesDir: string;
  uploadsDir: string;
  fetch?: typeof fetch;
};

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export class ServerLink {
  // devices of the owner on the server, from the last answer about commands: the health of the relay reports them
  devices = 0;
  // a second connection to relay.db, for reading only: PRAGMA data_version on it tells a write of the agent
  private readonly db: Database.Database;
  private version = -1;
  private sent = nothingSent();
  private readonly uploaded = { media: new Set<string>(), files: new Set<string>() };
  // when the account took its slot on the server (the series of its command ids), 0 until the server said
  private added = 0;
  // the last command of the series queued here
  private after = 0;
  // `ts` of the viewing the server has, sent from here or received
  private viewingTs = 0;
  private readonly errors = new Map<string, string>();

  constructor(private readonly o: ServerLinkOptions) {
    this.db = new Database(o.dbPath, { fileMustExist: true });
    this.db.pragma("busy_timeout = 8000");
  }

  // Sync out and commands in, until `signal` aborts
  async run(signal: AbortSignal) {
    log.info("server", "joining", { url: this.o.url });
    await Promise.all([this.loop("sync", signal, () => this.syncOnce().then(() => SYNC_EVERY_MS)), this.loop("commands", signal, () => this.pollCommands(signal))]);
    this.db.close();
  }

  // A step again and again: after an error it waits longer each time, up to 30 s, and logs each new error once
  private async loop(name: string, signal: AbortSignal, step: () => Promise<number>) {
    let failures = 0;
    while (!signal.aborted) {
      let wait: number;
      try {
        wait = await step();
        if (failures) log.info("server", `${name}: back`);
        failures = 0;
        this.errors.delete(name);
      } catch (e) {
        if (signal.aborted) break;
        failures++;
        const text = errorText(e);
        if (this.errors.get(name) !== text) log.warn("server", `${name}: ${text}`);
        this.errors.set(name, text);
        wait = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
      }
      await pause(wait, signal);
    }
  }

  private async call(method: string, p: string, o: { json?: unknown; body?: Uint8Array<ArrayBuffer>; signal?: AbortSignal; timeout?: number } = {}): Promise<Response> {
    const signals = [AbortSignal.timeout(o.timeout ?? 30_000), ...(o.signal ? [o.signal] : [])];
    const headers: Record<string, string> = { Authorization: `Bearer ${this.o.token}` };
    if (o.json !== undefined) headers["Content-Type"] = "application/json";
    if (o.body) headers["Content-Type"] = "application/octet-stream";
    const r = await (this.o.fetch ?? fetch)(this.o.url + p, {
      method,
      headers,
      body: o.json !== undefined ? JSON.stringify(o.json) : o.body,
      signal: AbortSignal.any(signals),
    });
    if (!r.ok) {
      let detail = "";
      try {
        detail = String(((await r.json()) as { detail?: unknown }).detail ?? "");
      } catch {
        // no JSON: the status says enough
      }
      throw new ServerError(r.status, detail);
    }
    return r;
  }

  // One sync: the files first (the rows name them), then what changed in relay.db. True when something went.
  async syncOnce(): Promise<boolean> {
    await this.uploadFiles();
    const version = this.db.pragma("data_version", { simple: true }) as number;
    if (version === this.version) return false;
    const { body, complete, commit } = this.changes();
    if (Object.keys(body).length > 1) await this.call("POST", "/api/relay/sync", { json: body, timeout: 60_000 });
    commit();
    // chats left for the next sync: that one reads again even without a new write
    if (complete) this.version = version;
    return Object.keys(body).length > 1;
  }

  private changes(): { body: SyncBody; complete: boolean; commit: () => void } {
    const body: SyncBody = { host: this.o.host };
    const next: Partial<Omit<Sent, "messages" | "state" | "readby" | "commands">> = {};
    const all = <T>(sql: string) => this.db.prepare(sql).all() as T[];

    const chats = all<ChatRow>("SELECT name, preview, pos, ts, tm, unread, mention, muted, av FROM chats ORDER BY pos");
    const chatsDigest = digest(chats);
    if (chatsDigest !== this.sent.chats) {
      body.chats = chats;
      next.chats = chatsDigest;
    }

    const byChat = new Map<string, MessageRow[]>();
    for (const { chat, ...m } of all<MessageRow & { chat: string }>("SELECT chat, idx, mid, author, text, mine, reacts, extra FROM chat_messages ORDER BY chat, idx")) {
      byChat.set(chat, [...(byChat.get(chat) ?? []), m]);
    }
    const messages: Record<string, MessageRow[]> = {};
    const messageDigests = new Map<string, string | null>();
    let room = MESSAGES_PER_SYNC;
    let complete = true;
    for (const [chat, rows] of byChat) {
      const d = digest(rows);
      if (this.sent.messages.get(chat) === d) continue;
      const size = JSON.stringify(rows).length;
      if (Object.keys(messages).length && size > room) {
        complete = false;
        continue;
      }
      room -= size;
      messages[chat] = rows;
      messageDigests.set(chat, d);
    }
    for (const chat of this.sent.messages.keys()) {
      if (byChat.has(chat)) continue;
      messages[chat] = [];
      messageDigests.set(chat, null);
    }
    if (Object.keys(messages).length) body.messages = messages;

    // results of the commands of the server go under their id there; the viewing only when newer than the server's
    const commands = this.serverCommands();
    const serverIdOf = new Map([...commands].map(([local, c]) => [local, c.id]));
    const state = new Map<string, string>();
    let viewing: { raw: string; ts: number } | null = null;
    for (const { k, v } of all<{ k: string; v: string | null }>("SELECT k, v FROM state")) {
      if (k === STATE.relay) continue;
      if (k === STATE.viewing) {
        const ts = parseState(Viewing, v, { chat: "", ts: 0 }).ts;
        if (ts > this.viewingTs) viewing = { raw: v ?? "", ts };
        continue;
      }
      const result = /^cmd_result:(\d+)$/.exec(k);
      if (!result) state.set(k, v ?? "");
      else if (serverIdOf.has(Number(result[1]))) state.set(cmdResultKey(serverIdOf.get(Number(result[1]))!), v ?? "");
    }
    const stateOut: Record<string, string | null> = {};
    const stateDigests = new Map<string, string | null>();
    for (const [k, v] of state) {
      const d = digest(v);
      if (this.sent.state.get(k) === d) continue;
      stateOut[k] = v;
      stateDigests.set(k, d);
    }
    for (const k of this.sent.state.keys()) {
      if (state.has(k)) continue;
      stateOut[k] = null;
      stateDigests.set(k, null);
    }
    if (viewing) stateOut[STATE.viewing] = viewing.raw;
    if (Object.keys(stateOut).length) body.state = stateOut;

    const activity = all<ActivityRow>("SELECT id, pos, kind, actor, title, emoji, preview, tm, chat, channel, unread, ts, av FROM activity ORDER BY pos");
    const activityDigest = digest(activity);
    if (activityDigest !== this.sent.activity) {
      body.activity = activity;
      next.activity = activityDigest;
    }
    const calls = all<CallRow>("SELECT since, caller, seconds FROM calls ORDER BY id");
    const callsDigest = digest(calls);
    if (callsDigest !== this.sent.calls) {
      body.calls = calls;
      next.calls = callsDigest;
    }

    const readby: ReadByRow[] = [];
    const readbyDigests = new Map<string, string>();
    for (const r of all<ReadByRow>("SELECT mid, chat, label, names, ts FROM readby")) {
      const d = digest(r);
      if (this.sent.readby.get(r.mid) === d) continue;
      readby.push(r);
      readbyDigests.set(r.mid, d);
    }
    if (readby.length) body.readby = readby;

    const statuses = [...commands.values()].filter((c) => this.sent.commands.get(c.id) !== c.status);
    if (statuses.length) body.commands = statuses;

    const commit = () => {
      Object.assign(this.sent, next);
      for (const [chat, d] of messageDigests) {
        if (d === null) this.sent.messages.delete(chat);
        else this.sent.messages.set(chat, d);
      }
      for (const [k, d] of stateDigests) {
        if (d === null) this.sent.state.delete(k);
        else this.sent.state.set(k, d);
      }
      for (const [mid, d] of readbyDigests) this.sent.readby.set(mid, d);
      for (const c of statuses) this.sent.commands.set(c.id, c.status);
      if (viewing) this.viewingTs = Math.max(this.viewingTs, viewing.ts);
    };
    return { body, complete, commit };
  }

  // The commands of the server queued here, of the current series: local id to the id and status there
  private serverCommands(): Map<number, { id: number; status: CommandStatus }> {
    const out = new Map<number, { id: number; status: CommandStatus }>();
    if (!this.added) return out;
    for (const r of this.db.prepare("SELECT id, key, status FROM commands WHERE key LIKE 'srv-%'").all() as { id: number; key: string; status: CommandStatus }[]) {
      const m = SERVER_COMMAND_KEY.exec(r.key);
      if (m && Number(m[1]) === this.added) out.set(r.id, { id: Number(m[2]), status: r.status });
    }
    return out;
  }

  // New images and attachments: the server says which it lacks, those go up one by one. Names are written once each
  // (src/agent/media.ts), so a name the server has is the same file. A file the server refuses (not the image its name
  // says, too large) is left out, logged: it must not hold up the sync of everything else.
  private async uploadFiles() {
    const fresh = { media: this.fresh("media", this.o.mediaDir, MEDIA_NAME), files: this.fresh("files", this.o.filesDir, FILE_NAME) };
    if (!fresh.media.length && !fresh.files.length) return;
    const missing = (await (await this.call("POST", "/api/relay/have", { json: fresh satisfies HaveBody })).json()) as HaveBody;
    for (const kind of ["media", "files"] as const) {
      const need = new Set(missing[kind]);
      const dir = kind === "media" ? this.o.mediaDir : this.o.filesDir;
      for (const name of fresh[kind]) {
        if (need.has(name)) {
          try {
            await this.call("PUT", `/api/relay/${kind}/${name}`, { body: new Uint8Array(fs.readFileSync(path.join(dir, name))), timeout: 300_000 });
          } catch (e) {
            if (!(e instanceof ServerError) || e.status < 400 || e.status >= 500 || e.status === 401) throw e;
            log.warn("server", `${kind} file refused: ${e.message}`, { file: name });
          }
        }
        this.uploaded[kind].add(name);
      }
    }
  }

  private fresh(kind: "media" | "files", dir: string, name: RegExp): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter((n) => name.test(n) && !this.uploaded[kind].has(n)).slice(0, 500);
  }

  // One wait for commands: the first one answers at once, with the series of the account
  private async pollCommands(signal: AbortSignal): Promise<number> {
    const wait = this.added ? "" : "&wait=0";
    const r = await this.call("GET", `/api/relay/commands?after=${this.after}&vts=${this.viewingTs}${wait}`, { signal, timeout: COMMANDS_WAIT_MS + 15_000 });
    const a = (await r.json()) as CommandsAnswer;
    if (a.added !== this.added) {
      log.info("server", this.added ? "the account is new on the server: its commands start again" : "joined", { added: a.added, devices: a.devices });
      this.added = a.added;
      this.after = this.lastQueued();
      this.sent.commands.clear();
      // the answer was asked for the series known before
      return 0;
    }
    this.devices = a.devices;
    if (a.viewing && a.viewing.ts > this.viewingTs) {
      this.viewingTs = a.viewing.ts;
      const local = parseState(Viewing, this.o.store.getState(STATE.viewing), { chat: "", ts: 0 });
      if (a.viewing.ts > local.ts) this.o.store.setState(STATE.viewing, JSON.stringify(a.viewing));
    }
    for (const c of a.commands) await this.queue(c);
    return 0;
  }

  // The last command of the current series queued here, from relay.db: a restart goes on from there
  private lastQueued(): number {
    let last = 0;
    for (const key of this.db.prepare("SELECT key FROM commands WHERE key LIKE ?").pluck().all(`srv-${this.added}-%`) as string[]) {
      const m = SERVER_COMMAND_KEY.exec(key);
      if (m) last = Math.max(last, Number(m[2]));
    }
    return last;
  }

  // A command of the app, queued here with the time the app queued it: one that waited too long fails like any other.
  // The image of sendimage comes first from the server.
  private async queue(c: ServerCommand) {
    if (c.type === "sendimage") {
      const { file } = parseArgs(ImageArgs, c.arg2);
      if (UPLOAD_NAME.test(file) && !fs.existsSync(path.join(this.o.uploadsDir, file))) {
        try {
          const data = Buffer.from(await (await this.call("GET", `/api/relay/uploads/${file}`, { timeout: 120_000 })).arrayBuffer());
          fs.mkdirSync(this.o.uploadsDir, { recursive: true });
          fs.writeFileSync(path.join(this.o.uploadsDir, file), data);
        } catch (e) {
          // the command fails on its missing upload, and the app says so
          log.warn("server", `image of command ${c.id}: ${errorText(e)}`);
        }
      }
    }
    this.o.store.enqueue(c.type as CommandType, c.arg1, c.arg2, serverCommandKey(this.added, c.id), c.ts);
    this.after = Math.max(this.after, c.id);
  }

  // A notification, sent by the server to the devices of the owner. Devices it went to, 0 when it could not go.
  async push(b: PushBody): Promise<number> {
    try {
      const r = await this.call("POST", "/api/relay/push", { json: b, timeout: 20_000 });
      return Number(((await r.json()) as { sent?: unknown }).sent) || 0;
    } catch (e) {
      log.warn("push", `through the server: ${errorText(e)}`, { op: b.op });
      return 0;
    }
  }
}

// The notifications of a joined relay: through the server, with its keys, to the devices of the owner of the account
export class ServerNotifier implements Notify {
  constructor(
    private readonly link: ServerLink,
    private readonly store: SlotStore,
  ) {}

  // the server keeps the history the app shows; the relay keeps the time of its last message, for its health
  async message(title: string, body: string, chat = "") {
    this.store.addNotification(title, body);
    await this.link.push({ op: "message", title, body: body || "", chat });
  }

  alert(title: string, body: string, urgency: webpush.Urgency = "high"): Promise<number> {
    return this.link.push({ op: "alert", title, body, urgency });
  }

  call(caller: string, state: "ringing" | "again" | "ended", since: number, seconds = 0): Promise<number> {
    return this.link.push({ op: "call", caller, state, since, seconds });
  }

  missedCall(caller: string, time: string): Promise<number> {
    return this.link.push({ op: "missedCall", caller, time });
  }

  deviceCount(): number {
    return this.link.devices;
  }
}
