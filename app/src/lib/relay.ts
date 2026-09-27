import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import type { z } from "zod";
import { MAX_DOWNLOAD } from "@/agent/logic/files";
import { Notifier } from "@/agent/push/notifier";
import { loadVapidKeys } from "@/agent/push/vapid";
import { AppStore } from "@/agent/store/app-store";
import { SlotStore } from "@/agent/store/slot-store";
import type { CommandsAnswer, HaveBody, PushBody, ServerCommand, SyncBody } from "@/shared/relay-sync";
import { FILE_NAME, MEDIA_NAME } from "@/shared/slot-db/rows";
import { ensureSlotSchema } from "@/shared/slot-db/schema";
import { parseState, STATE, Viewing } from "@/shared/slot-db/state";
import { appDb, relayAccount } from "./appdb";
import { config } from "./config";
import { body, HttpError } from "./http";
import { slotDbPath, slotDir } from "./slotdb";
import { imageExt } from "./uploads";

// Accounts on another computer (docs/design/2026-09-27-relay-joins-server.md): the local relay there keeps
// data/N/messages.db of its slot up to date through /api/relay/*, runs the commands the app queues in it and sends its
// notifications through the web app. The web app writes that database, as the agent of a slot does in the browsers
// container.

export const newRelayToken = () => crypto.randomBytes(32).toString("base64url");
export const relayDigest = (token: string) => crypto.createHash("sha256").update(token, "utf8").digest("hex");

export const ON_ANOTHER_COMPUTER = "This Teams account runs on another computer: start, stop and sign in there, in the window of its relay";

// The account of the relay calling: Authorization: Bearer <its token>. Never from a web page. The token is looked up by
// its digest: the database never holds it, and a wrong token tells nothing by its timing.
export function requireRelay(req: Request): { slot: number; added: number } {
  if (req.headers.has("origin")) throw new HttpError(403, "Requests from web pages are not accepted");
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  const found = m ? relayAccount(appDb(), relayDigest(m[1])) : null;
  if (!found) throw new HttpError(401, "Missing or wrong token", { "WWW-Authenticate": 'Bearer realm="teamsrelay"' });
  return { slot: found.slot, added: found.added };
}

// JSON body of a relay request, checked against its schema; a sync with every chat stays well under the limit
export async function relayJson<T>(req: Request, schema: z.ZodType<T>, maxBytes = 64e6): Promise<T> {
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes) throw new HttpError(413, "Body too large");
  const r = schema.safeParse(await body(req));
  if (!r.success) throw new HttpError(400, `Invalid body: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

// A new account on another computer starts from an empty database of the slot schema: the app finds the slot ready,
// with nothing in it, until the first sync
export function createRelaySlot(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
  SlotStore.open(path.join(dir, "messages.db")).close();
}

function writeSlotDb(slot: number): Database.Database {
  const file = slotDbPath(slot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 8000");
  ensureSlotSchema(db);
  return db;
}

const viewingTs = (v: string | null | undefined) => parseState(Viewing, v, { chat: "", ts: 0 }).ts;

// What changed in relay.db since the last sync, into data/N/messages.db, in one transaction: the app never sees a
// half-written sync. `viewing` only when newer than the one the app wrote; `relay` is the server's.
export function applySync(slot: number, b: SyncBody, now = Math.floor(Date.now() / 1000)) {
  const db = writeSlotDb(slot);
  try {
    db.transaction(() => {
      if (b.chats) {
        db.prepare("DELETE FROM chats").run();
        const insert = db.prepare("INSERT OR REPLACE INTO chats(name, preview, pos, ts, tm, unread, mention, muted, av) VALUES(?,?,?,?,?,?,?,?,?)");
        for (const c of b.chats) insert.run(c.name, c.preview, c.pos, c.ts, c.tm, c.unread, c.mention, c.muted, c.av);
      }
      if (b.messages) {
        const clear = db.prepare("DELETE FROM chat_messages WHERE chat=?");
        const insert = db.prepare("INSERT INTO chat_messages(chat, idx, mid, author, text, mine, reacts, extra) VALUES(?,?,?,?,?,?,?,?)");
        for (const [chat, rows] of Object.entries(b.messages)) {
          clear.run(chat);
          for (const m of rows) insert.run(chat, m.idx, m.mid, m.author, m.text, m.mine, m.reacts, m.extra);
        }
      }
      if (b.activity) {
        db.prepare("DELETE FROM activity").run();
        const insert = db.prepare(
          "INSERT OR REPLACE INTO activity(id, pos, kind, actor, title, emoji, preview, tm, chat, channel, unread, ts, av) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        );
        for (const a of b.activity) insert.run(a.id, a.pos, a.kind, a.actor, a.title, a.emoji, a.preview, a.tm, a.chat, a.channel, a.unread, a.ts, a.av);
      }
      if (b.calls) {
        db.prepare("DELETE FROM calls").run();
        const insert = db.prepare("INSERT INTO calls(since, caller, seconds) VALUES(?,?,?)");
        for (const c of b.calls) insert.run(c.since, c.caller, c.seconds);
      }
      if (b.readby) {
        const upsert = db.prepare("INSERT OR REPLACE INTO readby(mid, chat, label, names, ts) VALUES(?,?,?,?,?)");
        for (const r of b.readby) upsert.run(r.mid, r.chat, r.label, r.names, r.ts);
      }
      if (b.state) {
        const current = db.prepare("SELECT v FROM state WHERE k=?").pluck();
        const set = db.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)");
        const remove = db.prepare("DELETE FROM state WHERE k=?");
        for (const [k, v] of Object.entries(b.state)) {
          if (k === STATE.relay) continue;
          if (k === STATE.viewing) {
            if (v !== null && viewingTs(v) > viewingTs(current.get(k) as string | undefined)) set.run(k, v);
          } else if (v === null) remove.run(k);
          else set.run(k, v);
        }
      }
      if (b.commands) {
        const update = db.prepare("UPDATE commands SET status=? WHERE id=?");
        for (const c of b.commands) update.run(c.status, c.id);
      }
      db.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)").run(STATE.relay, JSON.stringify({ host: b.host, seen: now }));
    })();
  } finally {
    db.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The commands queued for the account after `after` (oldest first), and the chat the app shows when it shows one since
// later than `vts`: at once when there are any, otherwise as soon as some come, at the latest after `waitMs` with
// nothing. One connection for the whole wait.
export async function waitForRelayCommands(
  slot: number,
  { after, vts, waitMs, signal }: { after: number; vts: number; waitMs: number; signal?: AbortSignal },
): Promise<Pick<CommandsAnswer, "commands" | "viewing">> {
  const db = writeSlotDb(slot);
  try {
    const pending = db.prepare(
      "SELECT id, COALESCE(ts, 0) AS ts, type, COALESCE(arg1, '') AS arg1, COALESCE(arg2, '') AS arg2 FROM commands WHERE id > ? AND status='pending' ORDER BY id LIMIT 100",
    );
    const viewing = db.prepare("SELECT v FROM state WHERE k=?").pluck();
    const end = Date.now() + waitMs;
    for (;;) {
      const commands = pending.all(after) as ServerCommand[];
      const v = parseState(Viewing, viewing.get(STATE.viewing) as string | undefined, { chat: "", ts: 0 });
      const shown = v.chat && v.ts > vts ? v : null;
      if (commands.length || shown || Date.now() >= end || signal?.aborted) return { commands, viewing: shown };
      await sleep(250);
    }
  } finally {
    db.close();
  }
}

// One Notifier per account, as an agent has: the same text within 150 s goes out once. Kept for the life of the
// process, on globalThis: every route gets a copy of this module of its own (Next build).
type RelayPusher = { notifier: Notifier; store: SlotStore };
const shared = globalThis as typeof globalThis & { teamsrelayRelayPushers?: Map<number, RelayPusher> };
const pushers = () => (shared.teamsrelayRelayPushers ??= new Map());

function relayNotifier(slot: number): Notifier {
  let p = pushers().get(slot);
  if (!p) {
    let vapid = null;
    try {
      vapid = loadVapidKeys(config.vapidPrivateFile, config.vapidAppKeyFile);
    } catch (e) {
      console.error(`relay ${slot}: push keys: ${(e as Error).message}`);
    }
    const store = SlotStore.open(slotDbPath(slot));
    p = { store, notifier: new Notifier({ store, devices: new AppStore(config.appDb, slot), vapid, subject: config.vapidSubject, ntfy: config.ntfy }) };
    pushers().set(slot, p);
  }
  return p.notifier;
}

// The account is removed: its database goes, and a later account on the slot gets a Notifier of its own
export function forgetRelay(slot: number) {
  const p = pushers().get(slot);
  pushers().delete(slot);
  p?.store.close();
}

// A notification the relay passes on, to the devices of the owner of the account. Devices the push service took (for a
// message, the devices it went to: Notifier.message counts none).
export async function relayPush(slot: number, b: PushBody): Promise<number> {
  const n = relayNotifier(slot);
  switch (b.op) {
    case "message":
      await n.message(b.title, b.body, b.chat);
      return n.deviceCount();
    case "alert":
      return n.alert(b.title, b.body, b.urgency);
    case "call":
      return n.call(b.caller, b.state, b.since, b.seconds);
    case "missedCall":
      return n.missedCall(b.caller, b.time);
  }
}

// Images and profile pictures (media) and downloaded attachments (files) of the slot, uploaded by the relay
const KINDS = {
  media: { name: MEDIA_NAME, max: 10e6 },
  files: { name: FILE_NAME, max: MAX_DOWNLOAD },
} as const;
export type RelayFileKind = keyof typeof KINDS;

// Folder names written out: the build traces the files a path can reach, and a folder named by a variable makes it
// take in the whole project
const folderOf = (slot: number, kind: RelayFileKind) => (kind === "media" ? path.join(slotDir(slot), "media") : path.join(slotDir(slot), "files"));

// Of the files the relay has, the ones the slot lacks
export function missingRelayFiles(slot: number, have: HaveBody): HaveBody {
  const missing = (kind: RelayFileKind) => [...new Set(have[kind])].filter((n) => KINDS[kind].name.test(n) && !fs.existsSync(path.join(folderOf(slot, kind), n)));
  return { media: missing("media"), files: missing("files") };
}

// A file of the relay, written whole or not at all. An image must be the type its name says by its first bytes: the
// app serves it with that type.
export async function saveRelayFile(slot: number, kind: RelayFileKind, name: string, body: ReadableStream<Uint8Array> | null) {
  const k = KINDS[kind];
  if (!k.name.test(name)) throw new HttpError(400, "Invalid file name");
  if (!body) throw new HttpError(400, "Missing file");
  const dir = folderOf(slot, kind);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  const part = `${target}.${crypto.randomBytes(4).toString("hex")}.part`;
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      done(size > k.max ? new HttpError(413, "File too large") : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>), limit, fs.createWriteStream(part));
    if (!size) throw new HttpError(400, "Missing file");
    if (kind === "media") {
      const head = Buffer.alloc(16);
      const fd = fs.openSync(part, "r");
      try {
        fs.readSync(fd, head, 0, head.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (imageExt(head) !== path.extname(name).slice(1)) throw new HttpError(415, "Not the image its name says");
    }
    fs.renameSync(part, target);
  } finally {
    fs.rmSync(part, { force: true });
  }
}
