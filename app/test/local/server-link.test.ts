// A relay joined to a server: the real ServerLink of src/local against the real /api/relay/* routes of the web app,
// served in this process over HTTP, with the app database and the slot databases in a temporary folder. The agent is
// played by writes to relay.db; the Teams side of the relay is covered by test/local/relay.test.ts.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { log } from "@/agent/log";
import { Notifier } from "@/agent/push/notifier";
import { SlotStore } from "@/agent/store/slot-store";
import * as commandsRoute from "@/app/api/relay/commands/route";
import * as filesRoute from "@/app/api/relay/files/[file]/route";
import * as haveRoute from "@/app/api/relay/have/route";
import * as mediaRoute from "@/app/api/relay/media/[file]/route";
import * as pushRoute from "@/app/api/relay/push/route";
import * as syncRoute from "@/app/api/relay/sync/route";
import * as uploadsRoute from "@/app/api/relay/uploads/[file]/route";
import { appDb, migrateAppSchema, relayAccount, slotRow } from "@/lib/appdb";
import { relayDigest } from "@/lib/relay";
import { withSlot } from "@/lib/slotdb";
import { addRelayAccount, renewRelayToken } from "@/lib/slots";
import { ServerLink, ServerNotifier, type ServerLinkOptions } from "@/local/server-link";
import { serverCommandKey, type PushBody } from "@/shared/relay-sync";
import { cmdResultKey, STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

type Handler = (req: Request, ctx: { params: Promise<{ file: string }> }) => Promise<Response>;
const ROUTES: [string, RegExp, Handler][] = [
  ["POST", /^\/api\/relay\/sync$/, syncRoute.POST as Handler],
  ["GET", /^\/api\/relay\/commands$/, commandsRoute.GET as Handler],
  ["POST", /^\/api\/relay\/push$/, pushRoute.POST as Handler],
  ["POST", /^\/api\/relay\/have$/, haveRoute.POST as Handler],
  ["PUT", /^\/api\/relay\/media\/([^/]+)$/, mediaRoute.PUT as Handler],
  ["PUT", /^\/api\/relay\/files\/([^/]+)$/, filesRoute.PUT as Handler],
  ["GET", /^\/api\/relay\/uploads\/([^/]+)$/, uploadsRoute.GET as Handler],
];

let root: string;
let dataDir: string;
let relayDir: string;
let serverUrl: string;
let slot: number;
let token: string;
let server: http.Server;
let store: SlotStore;
let link: ServerLink;
let running: Promise<void>;
const stop = new AbortController();
// bodies of the syncs of the first account, and of every account by its token
const syncs: Record<string, unknown>[] = [];
const syncsOf = new Map<string, Record<string, unknown>[]>();
// notifications as the server took them, in that order
const pushed: PushBody[] = [];
// pictures a sync named while the server did not have them yet, by slot
const unseen: { slot: number; file: string }[] = [];
const refused: number[] = [];

const bearerOf = (req: http.IncomingMessage) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";

// What a sync names, checked the moment it comes: the pictures of its chats must be on the server already
function taken(req: http.IncomingMessage, b: Record<string, unknown>) {
  const bearer = bearerOf(req);
  if (bearer === token) syncs.push(b);
  syncsOf.set(bearer, [...(syncsOf.get(bearer) ?? []), b]);
  const account = relayAccount(appDb(), relayDigest(bearer));
  for (const c of (b.chats as { av?: string }[] | undefined) ?? []) {
    if (account && c.av && !fs.existsSync(path.join(dataDir, String(account.slot), "media", c.av))) unseen.push({ slot: account.slot, file: c.av });
  }
}

// The routes of the web app behind a plain HTTP server, as Next serves them
function serve() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const found = ROUTES.find(([method, re]) => method === req.method && re.test(url.pathname));
    if (!found) return void res.writeHead(404).end();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    if (url.pathname === "/api/relay/sync" && body) taken(req, JSON.parse(body.toString("utf8")) as Record<string, unknown>);
    if (url.pathname === "/api/relay/push" && body) pushed.push(JSON.parse(body.toString("utf8")) as PushBody);
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    const headers = Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(", ") : v] as [string, string]]));
    const request = new Request(url, { method: req.method, headers, body: req.method === "GET" ? undefined : body, signal: gone.signal });
    const response = await found[2](request, { params: Promise.resolve({ file: found[1].exec(url.pathname)?.[1] ?? "" }) });
    if (response.status >= 400) refused.push(response.status);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
}

async function until<T>(what: string, check: () => T | null | undefined | false, timeout = 20_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const using = <T>(file: string, fn: (db: Database.Database) => T): T => {
  const db = new Database(file, { fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
// The slot database of the server, as the web app reads it
const onServerAt = <T>(n: number, fn: (db: Database.Database) => T): T => using(path.join(dataDir, String(n), "messages.db"), fn);
const onServer = <T>(fn: (db: Database.Database) => T): T => onServerAt(slot, fn);
const serverStateAt = (n: number, k: string) => onServerAt(n, (db) => db.prepare("SELECT v FROM state WHERE k=?").pluck().get(k) as string | undefined);
const serverState = (k: string) => serverStateAt(slot, k);
// relay.db, written as the agent writes it
const inRelay = (sql: string, ...args: unknown[]) => using(path.join(relayDir, "relay.db"), (db) => db.prepare(sql).run(...args));

type Relay = { slot: number; token: string; added: number; dir: string; store: SlotStore };
type Joined = Relay & { link: ServerLink; start: () => void; stop: () => Promise<void> };
const joined: Joined[] = [];

// One more account on another computer, with a relay.db and a link of its own. `seed` fills relay.db (and the slot
// database of the server) before the link starts; start() starts it.
async function join(owner: string, o: Partial<ServerLinkOptions> = {}, seed?: (r: Relay) => void): Promise<Joined> {
  const { slot: n, token: t } = await addRelayAccount(owner, { db: appDb(), dataDir, slotCount: 16, perUser: 4 });
  const dir = path.join(root, `relay-${owner}`);
  const r: Relay = { slot: n, token: t, added: slotRow(appDb(), n)!.added, dir, store: SlotStore.open(path.join(dir, "relay.db")) };
  seed?.(r);
  const l = new ServerLink({
    url: serverUrl,
    token: t,
    host: "test-pc",
    dbPath: path.join(dir, "relay.db"),
    store: r.store,
    mediaDir: path.join(dir, "media"),
    filesDir: path.join(dir, "files"),
    uploadsDir: path.join(dir, "uploads"),
    ...o,
  });
  const stopper = new AbortController();
  let run: Promise<void> = Promise.resolve();
  const j: Joined = {
    ...r,
    link: l,
    start: () => void (run = l.run(stopper.signal)),
    stop: async () => {
      stopper.abort();
      await run;
      r.store.close();
    },
  };
  joined.push(j);
  return j;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  root = tempDir("teamsrelay-join-");
  dataDir = path.join(root, "data");
  relayDir = path.join(root, "relay");
  process.env.APP_DB = path.join(dataDir, "app.db");
  migrateAppSchema(appDb());
  ({ slot, token } = await addRelayAccount("owner-1", { db: appDb(), dataDir, slotCount: 16, perUser: 4 }));
  server = serve();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  store = SlotStore.open(path.join(relayDir, "relay.db"));
  store.saveChats([
    { name: "Test User (You)", preview: "You: note", time: "25/09", unread: false, mention: false, muted: false, av: "" },
    { name: "Anna Rossi", preview: "ciao", time: "12:19", unread: true, mention: false, muted: false, av: "0123456789abcdef.png" },
  ]);
  store.saveChatMessages("Anna Rossi", [{ mid: "1790431664072", author: "Anna Rossi", text: "ciao", mine: false, reacts: "", extra: { html: "<p>ciao</p>" } }]);
  store.saveChatMessages("Test User (You)", [{ mid: "1790431664999", author: "Test User", text: "note", mine: true, reacts: "", extra: { status: "Sent" } }]);
  store.setState(STATE.me, JSON.stringify({ name: "Test User", email: "test.user@contoso.example", tenant: "Contoso" }));
  store.setState(STATE.health, JSON.stringify({ cdp: "ok", ts: Math.floor(Date.now() / 1000), teams: "ok", overall: "green" }));
  store.saveActivity([{ id: "25006882909", kind: "call", actor: "Anna Rossi", title: "Missed call from Anna Rossi", emoji: "", preview: "", tm: "3:54 PM", chat: "Anna Rossi", channel: false, unread: false, av: "" }]);
  store.addCall("Anna Rossi", 1790500000000, 9);
  store.saveReadBy("1790431664999", "Test User (You)", { label: "Read by 0 of 1", names: [] });
  fs.mkdirSync(path.join(relayDir, "media"), { recursive: true });
  fs.writeFileSync(path.join(relayDir, "media", "0123456789abcdef.png"), PNG);

  link = new ServerLink({
    url: serverUrl,
    token,
    host: "test-pc",
    dbPath: path.join(relayDir, "relay.db"),
    store,
    mediaDir: path.join(relayDir, "media"),
    filesDir: path.join(relayDir, "files"),
    uploadsDir: path.join(relayDir, "uploads"),
  });
  running = link.run(stop.signal);
});

afterAll(async () => {
  stop.abort();
  await running;
  store?.close();
  await Promise.all(joined.map((j) => j.stop().catch(() => undefined)));
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  vi.restoreAllMocks();
});

describe("relay joined to a server", () => {
  it("mirrors relay.db into the slot database of the server, images first", async () => {
    await until("chats on the server", () => withSlot(slot, (r) => r.chats().length === 2));
    const seen = withSlot(slot, (r) => ({
      chats: r.chats().map((c) => [c.name, c.preview, c.tm, c.unread, c.av]),
      anna: r.messages("Anna Rossi").map((m) => [m.mid, m.text, m.html]),
      me: r.identity(),
      activity: r.activity().items.map((a) => a.id),
      calls: r.callLog(),
      health: r.health(0).overall,
    }));
    expect(seen).toEqual({
      chats: [
        ["Test User (You)", "You: note", "25/09", 0, ""],
        ["Anna Rossi", "ciao", "12:19", 1, "0123456789abcdef.png"],
      ],
      anna: [["1790431664072", "ciao", "<p>ciao</p>"]],
      me: { name: "Test User", email: "test.user@contoso.example", tenant: "Contoso" },
      activity: ["25006882909"],
      calls: [{ caller: "Anna Rossi", since: 1790500000000, seconds: 9 }],
      health: "green",
    });
    expect(onServer((db) => db.prepare("SELECT label FROM readby WHERE mid='1790431664999'").pluck().get())).toBe("Read by 0 of 1");
    expect(JSON.parse(serverState(STATE.relay) ?? "{}")).toMatchObject({ host: "test-pc", seen: expect.any(Number) });
    expect(fs.readFileSync(path.join(dataDir, String(slot), "media", "0123456789abcdef.png"))).toEqual(PNG);
  });

  it("sends only what changed, and removes on the server what went from relay.db", async () => {
    const before = syncs.length;
    store.saveChatMessages("Anna Rossi", [
      { mid: "1790431664072", author: "Anna Rossi", text: "ciao", mine: false, reacts: "", extra: null },
      { mid: "1790431665000", author: "Anna Rossi", text: "are you there?", mine: false, reacts: "", extra: null },
    ]);
    inRelay("DELETE FROM chat_messages WHERE chat='Test User (You)'");
    inRelay("DELETE FROM state WHERE k=?", STATE.me);
    await until("new message on the server", () => withSlot(slot, (r) => r.messages("Anna Rossi").length === 2));
    await until("self chat rows gone", () => withSlot(slot, (r) => !r.messages("Test User (You)").length && !r.identity().name));
    const sent = syncs.slice(before);
    // the chat list and the other tables did not change: they did not go again
    expect(sent.some((b) => "chats" in b || "activity" in b || "calls" in b)).toBe(false);
    expect(sent.flatMap((b) => Object.keys((b.messages as Record<string, unknown>) ?? {})).sort()).toEqual(["Anna Rossi", "Test User (You)"]);
  });

  it("runs the commands the app queues, with their time, and reports their outcome and result", async () => {
    const queued = Math.floor(Date.now() / 1000) - 5;
    // commands the app ran before: the ids of the server and of relay.db differ from here on
    onServer((db) => db.prepare("INSERT INTO commands(ts, type, arg1, arg2, status) VALUES(?, 'resync', '', '', 'done'), (?, 'resync', '', '', 'done')").run(queued, queued));
    const id = onServer((db) => Number(db.prepare("INSERT INTO commands(ts, type, arg1, arg2) VALUES(?, 'download', 'Anna Rossi', '{\"name\":\"a.xlsx\"}')").run(queued).lastInsertRowid));
    const added = appDb().prepare("SELECT added FROM teams_accounts WHERE slot=?").pluck().get(slot) as number;
    const local = await until("the command in relay.db", () => store.commandIdByKey(serverCommandKey(added, id)));
    expect(local).not.toBe(id);
    expect(store.pendingCommands().find((c) => c.id === local)).toMatchObject({ type: "download", arg1: "Anna Rossi" });
    const relayDb = new Database(path.join(relayDir, "relay.db"));
    expect(relayDb.prepare("SELECT ts FROM commands WHERE id=?").pluck().get(local)).toBe(queued);
    relayDb.close();

    // the agent runs it and saves the file it downloaded
    store.startCommand(local);
    fs.mkdirSync(path.join(relayDir, "files"), { recursive: true });
    fs.writeFileSync(path.join(relayDir, "files", "00112233445566ff.xlsx"), "sheet");
    store.setState(cmdResultKey(local), JSON.stringify({ f: "00112233445566ff.xlsx" }));
    store.finishCommand(local, "done");
    await until("done on the server", () => withSlot(slot, (r) => r.commandStatus(id)?.status === "done"));
    expect(withSlot(slot, (r) => r.commandStatus(id))).toEqual({ status: "done", result: { f: "00112233445566ff.xlsx" } });
    expect(fs.readFileSync(path.join(dataDir, String(slot), "files", "00112233445566ff.xlsx"), "utf8")).toBe("sheet");
  });

  it("fetches the image of a sendimage command before queueing it", async () => {
    const uploads = path.join(dataDir, String(slot), "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, "aaaabbbbccccdddd.png"), PNG);
    onServer((db) => db.prepare("INSERT INTO commands(ts, type, arg1, arg2) VALUES(?, 'sendimage', 'Anna Rossi', ?)").run(Math.floor(Date.now() / 1000), JSON.stringify({ file: "aaaabbbbccccdddd.png", text: "look" })));
    await until("sendimage in relay.db", () => store.pendingCommands().find((c) => c.type === "sendimage"));
    expect(fs.readFileSync(path.join(relayDir, "uploads", "aaaabbbbccccdddd.png"))).toEqual(PNG);
  });

  it("follows the chat the app shows, and sends the one the agent opens, without echo", async () => {
    const before = syncs.length;
    withSlot(slot, (r) => r.markViewing("Anna Rossi"));
    await until("viewing in relay.db", () => JSON.parse(store.getState(STATE.viewing) || "{}").chat === "Anna Rossi");
    // the write of the viewing is a change of relay.db: the sync after it must not send it back
    store.saveChats([{ name: "Anna Rossi", preview: "ok, later", time: "12:25", unread: false, mention: false, muted: false, av: "" }]);
    await until("the sync after", () => withSlot(slot, (r) => r.chats().find((c) => c.name === "Anna Rossi")?.preview === "ok, later"));
    const viewingsSent = syncs.slice(before).map((b) => (b.state as Record<string, string> | undefined)?.[STATE.viewing]).filter(Boolean);
    expect(viewingsSent).toEqual([]);

    const later = JSON.stringify({ chat: "Test User (You)", ts: Math.floor(Date.now() / 1000) + 30 });
    store.setState(STATE.viewing, later);
    await until("viewing on the server", () => serverState(STATE.viewing) === later);
    await new Promise((r) => setTimeout(r, 1500));
    expect(store.getState(STATE.viewing)).toBe(later);
  });

  it("leaves out an image the server refuses, and goes on syncing", async () => {
    fs.writeFileSync(path.join(relayDir, "media", "fedcba9876543210.png"), "not an image");
    store.saveChats([{ name: "Luca Bianchi", preview: "ok", time: "13:00", unread: false, mention: false, muted: false, av: "fedcba9876543210.png" }]);
    await until("the refusal", () => refused.includes(415));
    await until("the chat list after it", () => withSlot(slot, (r) => r.chats().some((c) => c.name === "Luca Bianchi")));
    expect(fs.existsSync(path.join(dataDir, String(slot), "media", "fedcba9876543210.png"))).toBe(false);
  });

  it("sends the notifications through the server, and keeps the time of the last message", async () => {
    const message = vi.spyOn(Notifier.prototype, "message").mockResolvedValue(undefined);
    const alert = vi.spyOn(Notifier.prototype, "alert").mockResolvedValue(2);
    const call = vi.spyOn(Notifier.prototype, "call").mockResolvedValue(1);
    const notifier = new ServerNotifier(link, store);
    await notifier.message("Anna Rossi", "are you there?", "Anna Rossi");
    expect(await notifier.alert("Teams signed out", "Sign in again", "high")).toBe(2);
    expect(await notifier.call("Anna Rossi", "ringing", 1790500000000)).toBe(1);
    expect(message).toHaveBeenCalledWith("Anna Rossi", "are you there?", "Anna Rossi");
    expect(alert).toHaveBeenCalledWith("Teams signed out", "Sign in again", "high");
    expect(call).toHaveBeenCalledWith("Anna Rossi", "ringing", 1790500000000, 0);
    expect(store.lastNotificationTs()).toBeGreaterThan(0);
  });

  it("stops being taken once the account has a new token, and says why", async () => {
    const warn = vi.spyOn(log, "warn");
    await renewRelayToken(slot, appDb());
    store.saveChats([{ name: "After the new token", preview: "", time: "14:00", unread: false, mention: false, muted: false, av: "" }]);
    await until("the refusal logged", () => warn.mock.calls.find((c) => /token refused \(401\)/.test(String(c[1]))));
    expect(withSlot(slot, (r) => r.chats().some((c) => c.name === "After the new token"))).toBe(false);
  });
});

describe("a relay.db past what one sync carries", () => {
  it("goes over in as many syncs as it takes, with the statuses of the last day only and without what the server refuses", async () => {
    const now = Math.floor(Date.now() / 1000);
    const warn = vi.spyOn(log, "warn");
    const j = await join("owner-big", { host: `office-${"x".repeat(150)}` }, (r) => {
      using(path.join(r.dir, "relay.db"), (db) =>
        db.transaction(() => {
          const readby = db.prepare("INSERT INTO readby(mid, chat, label, names, ts) VALUES(?,?,?,?,?)");
          for (let i = 0; i < 20_001; i++) readby.run(String(1_790_000_000_000 + i), "Anna Rossi", "Seen by 1", "[]", now);
          const state = db.prepare("INSERT INTO state(k, v) VALUES(?, ?)");
          for (let i = 0; i < 5_001; i++) state.run(`members:Chat ${i}`, JSON.stringify({ ts: now, names: ["Anna Rossi"] }));
          state.run("members:Too big", "x".repeat(2_000_001));
          const command = db.prepare("INSERT INTO commands(ts, type, arg1, arg2, key, status) VALUES(?, 'resync', '', '', ?, 'done')");
          for (let id = 1; id <= 6_000; id++) command.run(id <= 900 ? now - 2 * 86_400 : now - 60, serverCommandKey(r.added, id));
        })(),
      );
      // the same commands on the server, where the app queued them
      onServerAt(r.slot, (db) =>
        db.transaction(() => {
          const command = db.prepare("INSERT INTO commands(id, ts, type, arg1, arg2) VALUES(?, ?, 'resync', '', '')");
          for (let id = 1; id <= 6_000; id++) command.run(id, id <= 900 ? now - 2 * 86_400 : now - 60);
        })(),
      );
    });
    j.start();
    const count = (sql: string) => onServerAt(j.slot, (db) => db.prepare(sql).pluck().get() as number);
    await until("every Read by on the server", () => count("SELECT COUNT(*) FROM readby") === 20_001);
    await until("every key on the server", () => count("SELECT COUNT(*) FROM state WHERE k LIKE 'members:Chat %'") === 5_001);
    await until("the statuses of the last day", () => count("SELECT COUNT(*) FROM commands WHERE status='done'") === 5_100);
    expect(count("SELECT MIN(id) FROM commands WHERE status='done'")).toBe(901);
    const statuses = (syncsOf.get(j.token) ?? []).flatMap((b) => (b.commands as { id: number }[] | undefined) ?? []);
    expect(statuses.filter((c) => c.id <= 900)).toEqual([]);
    expect(serverStateAt(j.slot, "members:Too big")).toBeUndefined();
    expect(warn.mock.calls.some((c) => JSON.stringify(c).includes("members:Too big"))).toBe(true);
    expect(JSON.parse(serverStateAt(j.slot, STATE.relay) ?? "{}").host).toBe(`office-${"x".repeat(93)}`);
    await j.stop();
  });
});

describe("a relay whose clock is not the server's", () => {
  it("reads the times of the server by its own clock, and gives its own by the server's", async () => {
    // the clock of the server is 5 minutes behind this computer's: the Date of its answers says so
    const behind = 300;
    const skewed: typeof fetch = async (input, init) => {
      const r = await fetch(input, init);
      const date = Date.parse(r.headers.get("date") ?? "");
      if (Number.isNaN(date)) return r;
      const headers = new Headers(r.headers);
      headers.set("date", new Date(date - behind * 1000).toUTCString());
      return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
    };
    const j = await join("owner-clock", { fetch: skewed });
    j.start();
    const local = () => Math.floor(Date.now() / 1000);
    const serverNow = () => local() - behind;

    // queued by the app 5 s ago, by the clock of the server
    const id = onServerAt(j.slot, (db) => Number(db.prepare("INSERT INTO commands(ts, type, arg1, arg2) VALUES(?, 'resync', '', '')").run(serverNow() - 5).lastInsertRowid));
    const queued = await until("the command in relay.db", () => j.store.commandIdByKey(serverCommandKey(j.added, id)));
    const ts = using(path.join(j.dir, "relay.db"), (db) => db.prepare("SELECT ts FROM commands WHERE id=?").pluck().get(queued) as number);
    expect(Math.abs(ts - (local() - 5))).toBeLessThanOrEqual(2);

    // the app shows a chat since now, by the clock of the server
    onServerAt(j.slot, (db) => db.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)").run(STATE.viewing, JSON.stringify({ chat: "Anna Rossi", ts: serverNow() })));
    const shown = await until("the viewing in relay.db", () => {
      const v = JSON.parse(j.store.getState(STATE.viewing) || "{}") as { chat?: string; ts?: number };
      return v.chat === "Anna Rossi" && v;
    });
    expect(Math.abs((shown.ts ?? 0) - local())).toBeLessThanOrEqual(2);

    // the agent opens another chat, by the clock of this computer
    j.store.setState(STATE.viewing, JSON.stringify({ chat: "Luca Bianchi", ts: local() + 1 }));
    const sent = await until("the viewing on the server", () => {
      const v = JSON.parse(serverStateAt(j.slot, STATE.viewing) ?? "{}") as { chat?: string; ts?: number };
      return v.chat === "Luca Bianchi" && v;
    });
    expect(Math.abs((sent.ts ?? 0) - (serverNow() + 1))).toBeLessThanOrEqual(2);
    await j.stop();
  });
});

describe("the pictures a chat shows", () => {
  it("are on the server before the chat that names them", async () => {
    let wrote = false;
    let relay: Relay | null = null;
    // the agent saves a new picture, and the chat that shows it, while the relay asks the server about its files
    const racing: typeof fetch = async (input, init) => {
      if (!wrote && relay && String(input).endsWith("/api/relay/have")) {
        wrote = true;
        fs.writeFileSync(path.join(relay.dir, "media", "abababababababab.png"), PNG);
        relay.store.saveChats([{ name: "Carla Verdi", preview: "look", time: "10:00", unread: true, mention: false, muted: false, av: "abababababababab.png" }]);
      }
      return fetch(input, init);
    };
    const j = await join("owner-pictures", { fetch: racing }, (r) => {
      relay = r;
      fs.mkdirSync(path.join(r.dir, "media"), { recursive: true });
      fs.writeFileSync(path.join(r.dir, "media", "0123456789abcdef.png"), PNG);
      r.store.saveChats([{ name: "Anna Rossi", preview: "ciao", time: "12:19", unread: false, mention: false, muted: false, av: "0123456789abcdef.png" }]);
    });
    j.start();
    await until("the new chat on the server", () => withSlot(j.slot, (r) => r.chats().some((c) => c.name === "Carla Verdi")));
    expect(wrote).toBe(true);
    expect(unseen.filter((u) => u.slot === j.slot)).toEqual([]);
    await j.stop();
  });
});

describe("a sync whose files take a while", () => {
  it("sends the health and the call as they are when its rows go", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let holding = false;
    // the server takes the first picture only when the test says
    const slow: typeof fetch = async (input, init) => {
      if (init?.method === "PUT" && !holding) {
        holding = true;
        await gate;
      }
      return fetch(input, init);
    };
    const now = Math.floor(Date.now() / 1000);
    const j = await join("owner-live", { fetch: slow }, (r) => {
      fs.mkdirSync(path.join(r.dir, "media"), { recursive: true });
      fs.writeFileSync(path.join(r.dir, "media", "cdcdcdcdcdcdcdcd.png"), PNG);
      r.store.saveChats([{ name: "Anna Rossi", preview: "", time: "", unread: false, mention: false, muted: false, av: "cdcdcdcdcdcdcdcd.png" }]);
      r.store.setState(STATE.health, JSON.stringify({ cdp: "ok", ts: now - 30, teams: "ok", overall: "green" }));
      r.store.setState(STATE.call, JSON.stringify({ caller: "Anna Rossi", since: now * 1000 - 20_000, seen: now * 1000 - 15_000, ringing: true }));
    });
    j.start();
    await until("the picture on its way", () => holding);
    // written by the agent while the picture goes
    const health = JSON.stringify({ cdp: "ok", ts: Math.floor(Date.now() / 1000), teams: "ok", overall: "green" });
    const call = JSON.stringify({ caller: "Anna Rossi", since: now * 1000 - 20_000, seen: Date.now(), ringing: true });
    j.store.setState(STATE.health, health);
    j.store.setState(STATE.call, call);
    release();
    const first = await until("the first sync", () => syncsOf.get(j.token)?.[0]);
    expect((first.state as Record<string, string>)[STATE.health]).toBe(health);
    expect((first.state as Record<string, string>)[STATE.call]).toBe(call);
    await j.stop();
  });

  it("goes on without a file that fails, which goes again at the next sync", async () => {
    let failing = true;
    const flaky: typeof fetch = async (input, init) => {
      if (failing && init?.method === "PUT" && String(input).endsWith("/efefefefefefefef.png")) throw new TypeError("fetch failed");
      return fetch(input, init);
    };
    const j = await join("owner-flaky", { fetch: flaky }, (r) => {
      fs.mkdirSync(path.join(r.dir, "media"), { recursive: true });
      fs.writeFileSync(path.join(r.dir, "media", "efefefefefefefef.png"), PNG);
      r.store.saveChats([{ name: "Luca Bianchi", preview: "ok", time: "", unread: false, mention: false, muted: false, av: "efefefefefefefef.png" }]);
    });
    j.start();
    await until("the chats on the server", () => withSlot(j.slot, (r) => r.chats().some((c) => c.name === "Luca Bianchi")));
    const onServer = path.join(dataDir, String(j.slot), "media", "efefefefefefefef.png");
    expect(fs.existsSync(onServer)).toBe(false);
    failing = false;
    await until("the picture at last", () => fs.existsSync(onServer));
    await j.stop();
  });

  it("leaves out a picture the agent removed before its turn: no warning, nothing sent", async () => {
    const warn = vi.spyOn(log, "warn");
    let relay: Relay | null = null;
    let removed = false;
    let puts = 0;
    // while the relay asks the server about its files, the agent lists other chats and its media job removes the
    // picture no row names any more
    const racing: typeof fetch = async (input, init) => {
      if (!removed && relay && String(input).endsWith("/api/relay/have")) {
        removed = true;
        relay.store.saveChats([{ name: "Carla Verdi", preview: "", time: "", unread: false, mention: false, muted: false, av: "" }], true);
        fs.rmSync(path.join(relay.dir, "media", "a7a7a7a7a7a7a7a7.png"));
      }
      if (init?.method === "PUT") puts++;
      return fetch(input, init);
    };
    const j = await join("owner-pruned", { fetch: racing }, (r) => {
      relay = r;
      fs.mkdirSync(path.join(r.dir, "media"), { recursive: true });
      fs.writeFileSync(path.join(r.dir, "media", "a7a7a7a7a7a7a7a7.png"), PNG);
      r.store.saveChats([{ name: "Leaving Soon", preview: "", time: "", unread: false, mention: false, muted: false, av: "a7a7a7a7a7a7a7a7.png" }]);
    });
    j.start();
    await until("the list of now on the server", () => withSlot(j.slot, (r) => r.chats().some((c) => c.name === "Carla Verdi")));
    await sleep(1500);
    expect(removed).toBe(true);
    expect(puts).toBe(0);
    expect(warn.mock.calls.filter((c) => /file not sent/.test(String(c[1])))).toEqual([]);
    await j.stop();
  });

  it("forgets a picture waiting to go again once the agent removed it: when it comes back and fails, that is news", async () => {
    const warn = vi.spyOn(log, "warn");
    const flaky: typeof fetch = async (input, init) => {
      if (init?.method === "PUT" && String(input).endsWith("/b8b8b8b8b8b8b8b8.png")) throw new TypeError("fetch failed");
      return fetch(input, init);
    };
    let relay!: Relay;
    const picture = () => path.join(relay.dir, "media", "b8b8b8b8b8b8b8b8.png");
    const list = (name: string, av: string) => relay.store.saveChats([{ name, preview: "", time: "", unread: false, mention: false, muted: false, av }], true);
    const notSent = () => warn.mock.calls.filter((c) => /file not sent/.test(String(c[1])) && (c[2] as { file?: string } | undefined)?.file === "b8b8b8b8b8b8b8b8.png").length;
    const j = await join("owner-forgotten", { fetch: flaky }, (r) => {
      relay = r;
      fs.mkdirSync(path.join(r.dir, "media"), { recursive: true });
      fs.writeFileSync(picture(), PNG);
      list("Anna Rossi", "b8b8b8b8b8b8b8b8.png");
    });
    j.start();
    await until("the first failure", () => notSent() === 1);
    // the chat leaves the list and the media job removes its picture; later it is back, and the network fails again
    list("Luca Bianchi", "");
    fs.rmSync(picture());
    await until("the list without it on the server", () => withSlot(j.slot, (r) => r.chats().some((c) => c.name === "Luca Bianchi")));
    fs.writeFileSync(picture(), PNG);
    list("Anna Rossi", "b8b8b8b8b8b8b8b8.png");
    await until("the second failure, logged", () => notSent() === 2);
    await j.stop();
  });
});

describe("what a relay sends when it joins", () => {
  it("only the files its rows name: the rest of its folders stays on its computer", async () => {
    const j = await join("owner-named", {}, (r) => {
      fs.mkdirSync(path.join(r.dir, "media"), { recursive: true });
      fs.mkdirSync(path.join(r.dir, "files"), { recursive: true });
      for (const f of ["a1a1a1a1a1a1a1a1.png", "b2b2b2b2b2b2b2b2.png", "c3c3c3c3c3c3c3c3.png"]) fs.writeFileSync(path.join(r.dir, "media", f), PNG);
      fs.writeFileSync(path.join(r.dir, "files", "d4d4d4d4d4d4d4d4.pdf"), "%PDF-1.7");
      r.store.saveChats([{ name: "Anna Rossi", preview: "ciao", time: "12:19", unread: false, mention: false, muted: false, av: "a1a1a1a1a1a1a1a1.png" }]);
    });
    j.start();
    await until("the chat on the server", () => withSlot(j.slot, (r) => r.chats().some((c) => c.name === "Anna Rossi")));
    await sleep(1500);
    const on = (kind: string) => (fs.existsSync(path.join(dataDir, String(j.slot), kind)) ? fs.readdirSync(path.join(dataDir, String(j.slot), kind)) : []);
    expect({ media: on("media"), files: on("files") }).toEqual({ media: ["a1a1a1a1a1a1a1a1.png"], files: [] });
    await j.stop();
  });

  it("only the messages of the chats in its list, with their pictures", async () => {
    const j = await join("owner-listed", {}, (r) => {
      fs.mkdirSync(path.join(r.dir, "media"), { recursive: true });
      for (const f of ["e5e5e5e5e5e5e5e5.png", "f6f6f6f6f6f6f6f6.png"]) fs.writeFileSync(path.join(r.dir, "media", f), PNG);
      r.store.saveChats([{ name: "Anna Rossi", preview: "look", time: "12:19", unread: false, mention: false, muted: false, av: "" }]);
      const image = (f: string) => ({ images: [{ f, w: 10, h: 10 }] });
      r.store.saveChatMessages("Anna Rossi", [{ mid: "1790431664072", author: "Anna Rossi", text: "look", mine: false, reacts: "", extra: image("e5e5e5e5e5e5e5e5.png") }]);
      // opened months ago, long gone from the list
      r.store.saveChatMessages("Old project", [{ mid: "1780000000000", author: "Luca Bianchi", text: "old", mine: false, reacts: "", extra: image("f6f6f6f6f6f6f6f6.png") }]);
    });
    j.start();
    await until("the messages on the server", () => withSlot(j.slot, (r) => r.messages("Anna Rossi").length === 1));
    await sleep(1500);
    expect(onServerAt(j.slot, (db) => db.prepare("SELECT DISTINCT chat FROM chat_messages").pluck().all())).toEqual(["Anna Rossi"]);
    expect(fs.readdirSync(path.join(dataDir, String(j.slot), "media"))).toEqual(["e5e5e5e5e5e5e5e5.png"]);
    await j.stop();
  });
});

describe("a picture the server removed", () => {
  it("leaves the server with the chat that showed it, and goes again before the chat when it is back", async () => {
    const picture = "a8a8a8a8a8a8a8a8.png";
    let relay!: Relay;
    const onServer = () => fs.existsSync(path.join(dataDir, String(relay.slot), "media", picture));
    const list = (name: string, av: string) => relay.store.saveChats([{ name, preview: "", time: "", unread: false, mention: false, muted: false, av }], true);
    const j = await join("owner-back", {}, (r) => {
      relay = r;
      fs.mkdirSync(path.join(r.dir, "media"), { recursive: true });
      fs.writeFileSync(path.join(r.dir, "media", picture), PNG);
      list("Anna Rossi", picture);
    });
    j.start();
    await until("the picture on the server", () => onServer());
    // the chat leaves the list; the relay keeps the picture (its media job has not run since)
    list("Luca Bianchi", "");
    await until("the picture gone from the server", () => !onServer());
    list("Anna Rossi", picture);
    await until("the chat back on the server", () => withSlot(j.slot, (r) => r.chats().some((c) => c.name === "Anna Rossi")));
    expect(onServer()).toBe(true);
    expect(unseen.filter((u) => u.slot === j.slot)).toEqual([]);
    await j.stop();
  });
});

describe("a picture the server has no room for", () => {
  it("is logged once, and goes again when a later sync names it, once the server has room", async () => {
    const warn = vi.spyOn(log, "warn");
    const [first, second] = ["c9c9c9c9c9c9c9c9.png", "d0d0d0d0d0d0d0d0.png"];
    // what the server answered to each upload of the second picture
    const puts: number[] = [];
    const counting: typeof fetch = async (input, init) => {
      const r = await fetch(input, init);
      if (init?.method === "PUT" && String(input).endsWith(`/${second}`)) puts.push(r.status);
      return r;
    };
    let relay!: Relay;
    const onServer = (f: string) => fs.existsSync(path.join(dataDir, String(relay.slot), "media", f));
    const list = (...chats: [string, string][]) =>
      relay.store.saveChats(
        chats.map(([name, av]) => ({ name, preview: "", time: "", unread: false, mention: false, muted: false, av })),
        true,
      );
    const refusals = () => warn.mock.calls.filter((c) => /file refused/.test(String(c[1])) && (c[2] as { file?: string } | undefined)?.file === second).length;
    // room for one picture
    process.env.RELAY_QUOTA_MB = String((PNG.length + 10) / 2 ** 20);
    try {
      const j = await join("owner-room", { fetch: counting }, (r) => {
        relay = r;
        fs.mkdirSync(path.join(r.dir, "media"), { recursive: true });
        for (const f of [first, second]) fs.writeFileSync(path.join(r.dir, "media", f), PNG);
        list(["Anna Rossi", first], ["Luca Bianchi", second]);
      });
      j.start();
      await until("the refusal", () => refusals() === 1);
      expect([onServer(first), onServer(second)]).toEqual([true, false]);
      // the chat of the first one leaves the list: the sync naming the second one finds no room yet, and the first one
      // leaves the server once the rows are there
      list(["Luca Bianchi", second]);
      await until("the first picture gone from the server", () => !onServer(first));
      list(["Luca Bianchi", second], ["Carla Verdi", ""]);
      await until("the second picture at last", () => puts.at(-1) === 200);
      expect(puts).toEqual([413, 413, 200]);
      expect(onServer(second)).toBe(true);
      expect(refusals()).toBe(1);
      await j.stop();
    } finally {
      delete process.env.RELAY_QUOTA_MB;
    }
  });

  it("refused after a failure of the network, waits for a later sync that names it", async () => {
    const picture = "abcdabcdabcdabcd.png";
    let failing = true;
    const puts: number[] = [];
    const flaky: typeof fetch = async (input, init) => {
      if (init?.method !== "PUT" || !String(input).endsWith(`/${picture}`)) return fetch(input, init);
      if (failing) {
        failing = false;
        throw new TypeError("fetch failed");
      }
      const r = await fetch(input, init);
      puts.push(r.status);
      return r;
    };
    const j = await join("owner-refused-late", { fetch: flaky }, (r) => {
      fs.mkdirSync(path.join(r.dir, "media"), { recursive: true });
      fs.writeFileSync(path.join(r.dir, "media", picture), "not an image");
      r.store.saveChats([{ name: "Anna Rossi", preview: "", time: "", unread: false, mention: false, muted: false, av: picture }]);
    });
    j.start();
    await until("the refusal", () => puts.length === 1);
    // the relay syncs every second: a file still waiting to go again would go at each one
    await sleep(2500);
    expect(puts).toEqual([415]);
    await j.stop();
  });
});

describe("a key longer than the server takes", () => {
  it("stays here, and once gone holds up nothing", async () => {
    const long = `members:${"x".repeat(1100)}`;
    const j = await join("owner-long", {}, (r) => {
      r.store.setState(long, "{}");
      r.store.saveChats([{ name: "Anna Rossi", preview: "", time: "", unread: false, mention: false, muted: false, av: "" }]);
    });
    j.start();
    await until("the first sync", () => withSlot(j.slot, (r) => r.chats().some((c) => c.name === "Anna Rossi")));
    using(path.join(j.dir, "relay.db"), (db) => db.prepare("DELETE FROM state WHERE k=?").run(long));
    j.store.saveChats([{ name: "After the long key", preview: "", time: "", unread: false, mention: false, muted: false, av: "" }]);
    await until("the chat after it", () => withSlot(j.slot, (r) => r.chats().some((c) => c.name === "After the long key")));
    await j.stop();
  });
});

describe("notifications through the server", () => {
  it("never hold up the agent, go in order, and are dropped when older than two minutes by their turn", async () => {
    let now = Date.now();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    // the server takes no notification until the gate opens
    const slow: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/api/relay/push")) await gate;
      return fetch(input, init);
    };
    vi.spyOn(Notifier.prototype, "message").mockResolvedValue(undefined);
    const j = await join("owner-push", { fetch: slow, clock: () => now });
    j.start();
    const notifier = new ServerNotifier(j.link, j.store);
    const first = await Promise.race([notifier.message("Anna Rossi", "one", "Anna Rossi").then(() => "returned"), sleep(1000).then(() => "held")]);
    expect(first).toBe("returned");
    void notifier.message("Anna Rossi", "two", "Anna Rossi");
    // the first one takes over two minutes: the second one is too old by its turn
    now += 121_000;
    open();
    await until("the first one on the server", () => pushed.some((p) => p.op === "message" && p.body === "one"));
    for (const body of ["three", "four", "five"]) void notifier.message("Anna Rossi", body, "Anna Rossi");
    await until("the last one on the server", () => pushed.some((p) => p.op === "message" && p.body === "five"));
    const bodies = pushed.flatMap((p) => (p.op === "message" && ["one", "two", "three", "four", "five"].includes(p.body) ? [p.body] : []));
    expect(bodies).toEqual(["one", "three", "four", "five"]);
    await j.stop();
  });
});

describe("a relay that stops", () => {
  it("stops at once, with a request on its way", async () => {
    let inFlight!: () => void;
    const started = new Promise<void>((r) => (inFlight = r));
    // the server never answers a sync
    const stuck: typeof fetch = (input, init) => {
      if (!String(input).endsWith("/api/relay/sync")) return fetch(input, init);
      inFlight();
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    };
    const j = await join("owner-stop", { fetch: stuck }, (r) =>
      r.store.saveChats([{ name: "Anna Rossi", preview: "", time: "", unread: false, mention: false, muted: false, av: "" }]),
    );
    j.start();
    await started;
    const t = Date.now();
    await j.stop();
    expect(Date.now() - t).toBeLessThan(3000);
  });
});
