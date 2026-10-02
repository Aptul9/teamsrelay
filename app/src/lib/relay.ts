import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import Database from "better-sqlite3";
import type { z } from "zod";
import { MAX_DOWNLOAD } from "@/agent/logic/files";
import { FcmSender, loadServiceAccount } from "@/agent/push/fcm";
import { Notifier, type PushDevices } from "@/agent/push/notifier";
import { loadVapidKeys } from "@/agent/push/vapid";
import { AppStore } from "@/agent/store/app-store";
import { pruneMedia } from "@/agent/media";
import { mediaFilesOf, SlotStore } from "@/agent/store/slot-store";
import { bearerToken } from "@/shared/bearer";
import { LIVE_KEYS, RELAY_FILE_NAME, type CommandsAnswer, type HaveBody, type PushBody, type ServerCommand, type SyncBody } from "@/shared/relay-sync";
import { ensureSlotSchema, insertRow } from "@/shared/slot-db/schema";
import { parseState, STATE, Viewing } from "@/shared/slot-db/state";
import { appDb, relayAccount, slotRow } from "./appdb";
import { config } from "./config";
import { declaredLength, HttpError } from "./http";
import { SlotNotReady, slotDbPath, slotDir } from "./slotdb";
import { imageExt } from "./uploads";

// Accounts on another computer (docs/design/2026-09-27-relay-joins-server.md): the local relay there keeps
// data/N/messages.db of its slot up to date through /api/relay/*, runs the commands the app queues in it and sends its
// notifications through the web app. The web app writes that database, as the agent of a slot does in the browsers
// container.

export const newRelayToken = () => crypto.randomBytes(32).toString("base64url");
export const relayDigest = (token: string) => crypto.createHash("sha256").update(token, "utf8").digest("hex");

export const ON_ANOTHER_COMPUTER = "This Teams account runs on another computer: start, stop and sign in there, in the window of its relay";

// The account a request of a relay comes from: its slot, when the account took the slot, and the digest of the token
// the request came with
export type RelayCaller = { slot: number; added: number; digest: string };

const refused = () => new HttpError(401, "Missing or wrong token", { "WWW-Authenticate": 'Bearer realm="teamsrelay"' });

// The account of the relay calling: Authorization: Bearer <its token>. Never from a web page. The token is looked up by
// its digest: the database never holds it, and a wrong token tells nothing by its timing.
export function requireRelay(req: Request): RelayCaller {
  if (req.headers.has("origin")) throw new HttpError(403, "Requests from web pages are not accepted");
  const token = bearerToken(req.headers.get("authorization"));
  const digest = token ? relayDigest(token) : "";
  const found = digest ? relayAccount(appDb(), digest) : null;
  if (!found) throw refused();
  return { slot: found.slot, added: found.added, digest };
}

// Right before a write, with nothing awaited between the check and the write: the token still belongs to the account
// the request started for. A request that read its body, or waited, while the account was removed or got a new token
// writes nothing: the slot may be another account's by now.
function stillRelay(caller: RelayCaller) {
  const found = relayAccount(appDb(), caller.digest);
  if (!found || found.slot !== caller.slot || found.added !== caller.added) throw refused();
}

// JSON body of a relay request, checked against its schema. Its bytes are counted as they come, whatever
// Content-Length says (a chunked body has none); a sync with every chat stays well under the limit.
export async function relayJson<T>(req: Request, schema: z.ZodType<T>, maxBytes = 64e6): Promise<T> {
  const tooLarge = () => new HttpError(413, "Body too large");
  if ((declaredLength(req) ?? 0) > maxBytes) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, `Invalid body: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

// A new account on another computer starts from an empty database of the slot schema: the app finds the slot ready,
// with nothing in it, until the first sync
export function createRelaySlot(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
  SlotStore.open(path.join(dir, "messages.db")).close();
}

// The file of the database of the slot, SlotNotReady while it is not there
function slotDbFile(slot: number): string {
  const file = slotDbPath(slot);
  if (!fs.existsSync(file)) throw new SlotNotReady();
  return file;
}

// The database of the slot, made when the account was added (createRelaySlot) and never here: a request of an account
// removed meanwhile cannot bring its folder back
function openSlotDb(slot: number): Database.Database {
  const db = new Database(slotDbFile(slot), { fileMustExist: true });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 8000");
  ensureSlotSchema(db);
  return db;
}

const viewingTs = (v: string | null | undefined) => parseState(Viewing, v).ts;

// The health the agent of the relay rewrites every few seconds, the call while it rings and the call in progress, go by
// the clock of the server: the app judges each by its age, and the clock of the other computer may be off. Each keeps
// the age it had on the relay when it was sent (`at`: a time of the relay, ms, on the server's clock).
function onServerClock(k: string, v: string, at: (ms: number) => number): string {
  if (!LIVE_KEYS.includes(k)) return v;
  try {
    const o = JSON.parse(v) as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return v;
    const row = o as Record<string, unknown>;
    if (k === STATE.health && typeof row.ts === "number") return JSON.stringify({ ...row, ts: Math.floor(at(row.ts * 1000) / 1000) });
    if (k === STATE.call && row.ringing === true && typeof row.seen === "number") return JSON.stringify({ ...row, seen: at(row.seen) });
    if (k === STATE.inCall && row.active === true && typeof row.seen === "number") return JSON.stringify({ ...row, seen: at(row.seen) });
  } catch {
    // not JSON: kept as the relay sent it
  }
  return v;
}

// What changed in relay.db since the last sync, into data/N/messages.db, in one transaction: the app never sees a
// half-written sync. `viewing` only when newer than the one the app wrote; `relay` is the server's. Once rows that name
// pictures changed, the pictures no row names any more leave the server (pruneRelayMedia).
export function applySync(caller: RelayCaller, b: SyncBody, now = Date.now()) {
  stillRelay(caller);
  const db = openSlotDb(caller.slot);
  const at = (ms: number) => Math.min(now, ms + now - b.now);
  try {
    db.transaction(() => {
      if (b.chats) {
        db.prepare("DELETE FROM chats").run();
        const insert = db.prepare(insertRow("chats"));
        for (const c of b.chats) insert.run(c.name, c.preview, c.pos, c.ts, c.tm, c.unread, c.mention, c.muted, c.av, c.presence ?? null, c.kind ?? "");
      }
      if (b.messages) {
        const clear = db.prepare("DELETE FROM chat_messages WHERE chat=?");
        const insert = db.prepare(insertRow("chat_messages"));
        for (const [chat, rows] of Object.entries(b.messages)) {
          clear.run(chat);
          for (const m of rows) insert.run(chat, m.idx, m.mid, m.author, m.text, m.mine, m.reacts, m.extra);
        }
      }
      if (b.activity) {
        db.prepare("DELETE FROM activity").run();
        const insert = db.prepare(insertRow("activity"));
        for (const a of b.activity) insert.run(a.id, a.pos, a.kind, a.actor, a.title, a.emoji, a.preview, a.tm, a.chat, a.channel, a.unread, a.ts, a.av);
      }
      if (b.calls) {
        db.prepare("DELETE FROM calls").run();
        const insert = db.prepare(insertRow("calls"));
        for (const c of b.calls) insert.run(c.since, c.caller, c.seconds);
      }
      if (b.readby) {
        const upsert = db.prepare(insertRow("readby"));
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
          else set.run(k, onServerClock(k, v, at));
        }
      }
      if (b.commands) {
        const update = db.prepare("UPDATE commands SET status=? WHERE id=?");
        for (const c of b.commands) update.run(c.status, c.id);
      }
      db.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)").run(STATE.relay, JSON.stringify({ host: b.host, seen: Math.floor(now / 1000) }));
    })();
    // a picture goes unnamed only when rows mediaFilesOf reads change
    if (b.chats || b.messages || b.activity || (b.state && STATE.me in b.state)) pruneRelayMedia(caller, mediaFilesOf(db));
  } finally {
    db.close();
  }
}


// The commands queued for the account after `after` (oldest first), and the chat the app shows (none: it stopped
// showing one) when that changed later than `vts`: at once when there are any, otherwise as soon as some come, at the
// latest after `waitMs` with nothing. One connection for the whole wait, which ends at once when the token stops working.
export async function waitForRelayCommands(
  caller: RelayCaller,
  { after, vts, waitMs, signal }: { after: number; vts: number; waitMs: number; signal?: AbortSignal },
): Promise<Pick<CommandsAnswer, "commands" | "viewing">> {
  const db = openSlotDb(caller.slot);
  try {
    const pending = db.prepare(
      "SELECT id, COALESCE(ts, 0) AS ts, type, COALESCE(arg1, '') AS arg1, COALESCE(arg2, '') AS arg2 FROM commands WHERE id > ? AND status='pending' ORDER BY id LIMIT 100",
    );
    const viewing = db.prepare("SELECT v FROM state WHERE k=?").pluck();
    const end = Date.now() + waitMs;
    for (;;) {
      stillRelay(caller);
      const commands = pending.all(after) as ServerCommand[];
      const v = parseState(Viewing, viewing.get(STATE.viewing) as string | undefined);
      const shown = v.ts > vts ? v : null;
      if (commands.length || shown || Date.now() >= end || signal?.aborted) return { commands, viewing: shown };
      await sleep(250);
    }
  } finally {
    db.close();
  }
}

// One Notifier per account, as an agent has: the same text within 150 s goes out once. Kept for the life of the
// process, on globalThis: every route gets a copy of this module of its own (Next build). The room of the account
// (saveRelayFile) the same way.
type RelayPusher = { added: number; notifier: Notifier; store: SlotStore };
type RelayRoom = { added: number; used: number };
const shared = globalThis as typeof globalThis & { teamsrelayRelayPushers?: Map<number, RelayPusher>; teamsrelayRelayRooms?: Map<number, RelayRoom> };
const pushers = () => (shared.teamsrelayRelayPushers ??= new Map());
const rooms = () => (shared.teamsrelayRelayRooms ??= new Map());

// The account that took the slot at `added` still holds it, whatever its token now
function holds(slot: number, added: number) {
  const s = slotRow(appDb(), slot);
  return !!s?.relay && s.added === added;
}

function relayNotifier(caller: RelayCaller): Notifier {
  const known = pushers().get(caller.slot);
  if (known?.added === caller.added) return known.notifier;
  if (known) forgetRelay(caller.slot);
  const push = config.push;
  let vapid = null;
  try {
    vapid = loadVapidKeys(push.vapid.privateKeyFile, push.vapid.appKeyFile);
  } catch (e) {
    console.error(`relay ${caller.slot}: push keys: ${(e as Error).message}`);
  }
  // the phones of the Android app, as the agents reach them; a key file that is no service account key leaves them
  // without notifications, and the browsers with theirs
  let fcm: FcmSender | null = null;
  try {
    const sa = loadServiceAccount(push.fcmCredentials);
    if (sa) fcm = new FcmSender(sa);
  } catch (e) {
    console.error(`relay ${caller.slot}: FCM key: ${(e as Error).message}`);
  }
  const store = SlotStore.open(slotDbFile(caller.slot));
  const app = new AppStore(config.appDb, caller.slot);
  const { slot, added } = caller;
  // the devices of the owner while the account holds the slot: a notification still on its way when the account is
  // removed goes to nobody, even once the slot is someone else's
  const devices: PushDevices = {
    targets: () => (holds(slot, added) ? app.targets() : []),
    remove: (endpoint) => app.remove(endpoint),
    account: (me) => app.account(me),
  };
  const notifier = new Notifier({ store, devices, vapid, subject: push.vapid.subject, ntfy: push.ntfy, fcm, answerable: true });
  pushers().set(slot, { added, store, notifier });
  return notifier;
}

// The account is removed: its database goes, and a later account on the slot gets a Notifier and a room of its own
export function forgetRelay(slot: number) {
  const p = pushers().get(slot);
  pushers().delete(slot);
  rooms().delete(slot);
  p?.store.close();
}

// A notification the relay passes on, to the devices of the owner of the account. Devices the push service took (for a
// message, the devices it went to: Notifier.message counts none).
export async function relayPush(caller: RelayCaller, b: PushBody): Promise<number> {
  stillRelay(caller);
  const n = relayNotifier(caller);
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
  media: { name: RELAY_FILE_NAME.media, max: 10e6 },
  files: { name: RELAY_FILE_NAME.files, max: MAX_DOWNLOAD },
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

// The pictures no row of the slot names any more leave its media folder, as the agent of a slot removes them from its
// own (src/agent/media.ts): the picture of a chat that left the list, of an item gone from the feed, the images of
// messages no longer kept. One that shows again goes again: the relay asks about the files of every sync that names
// them. Their bytes go back to the room of the account. Attachments stay until the account is removed.
function pruneRelayMedia(caller: RelayCaller, named: ReadonlySet<string>) {
  const room = rooms().get(caller.slot);
  pruneMedia(folderOf(caller.slot, "media"), named, (size) => {
    if (room) room.used -= size;
  });
}

// Bytes of the files of a folder, 0 without the folder
function folderBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile()) total += fs.statSync(path.join(dir, e.name), { throwIfNoEntry: false })?.size ?? 0;
  }
  return total;
}

// Bytes the account takes with its images and attachments: counted from its folders once, then kept by the uploads
function roomOf(caller: RelayCaller): RelayRoom {
  let r = rooms().get(caller.slot);
  if (!r || r.added !== caller.added) {
    r = { added: caller.added, used: folderBytes(folderOf(caller.slot, "media")) + folderBytes(folderOf(caller.slot, "files")) };
    rooms().set(caller.slot, r);
  }
  return r;
}

// A file of the relay, written whole or not at all, within the room of the account (RELAY_QUOTA_MB). `length`: its
// Content-Length, which refuses a file too large before a byte of it is read (a refusal in the middle of a body can
// reach the relay as a reset connection instead of its answer); the bytes are counted as they come all the same, and
// held against the room while they do, so uploads side by side share it. An image must be the type its name says by
// its first bytes: the app serves it with that type.
export async function saveRelayFile(caller: RelayCaller, kind: RelayFileKind, name: string, body: ReadableStream<Uint8Array> | null, length: number | null = null) {
  const k = KINDS[kind];
  if (!k.name.test(name)) throw new HttpError(400, "Invalid file name");
  if (!body) throw new HttpError(400, "Missing file");
  // the folder of the slot comes with the account, never from here
  slotDbFile(caller.slot);
  const room = roomOf(caller);
  const quota = config.relayQuotaBytes;
  const tooLarge = () => new HttpError(413, "File too large");
  const noRoom = () => new HttpError(413, "No room left for the files of this account on the server");
  if (length !== null && Number.isFinite(length)) {
    if (length > k.max) throw tooLarge();
    if (room.used + length > quota) throw noRoom();
  }
  const dir = folderOf(caller.slot, kind);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  const part = `${target}.${crypto.randomBytes(4).toString("hex")}.part`;
  let size = 0;
  let held = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > k.max) return done(tooLarge());
      if (room.used + chunk.length > quota) return done(noRoom());
      room.used += chunk.length;
      held += chunk.length;
      done(null, chunk);
    },
  });
  let kept = false;
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
    stillRelay(caller);
    const replaced = fs.statSync(target, { throwIfNoEntry: false })?.size ?? 0;
    fs.renameSync(part, target);
    room.used -= replaced;
    kept = true;
  } finally {
    if (!kept) room.used -= held;
    fs.rmSync(part, { force: true });
  }
}

