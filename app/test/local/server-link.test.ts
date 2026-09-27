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
import { appDb, migrateAppSchema } from "@/lib/appdb";
import { withSlot } from "@/lib/slotdb";
import { addRelayAccount, renewRelayToken } from "@/lib/slots";
import { ServerLink, ServerNotifier } from "@/local/server-link";
import { serverCommandKey } from "@/shared/relay-sync";
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

let dataDir: string;
let relayDir: string;
let slot: number;
let token: string;
let server: http.Server;
let store: SlotStore;
let link: ServerLink;
let running: Promise<void>;
const stop = new AbortController();
const syncs: Record<string, unknown>[] = [];
const refused: number[] = [];

// The routes of the web app behind a plain HTTP server, as Next serves them
function serve() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const found = ROUTES.find(([method, re]) => method === req.method && re.test(url.pathname));
    if (!found) return void res.writeHead(404).end();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    if (url.pathname === "/api/relay/sync" && body) syncs.push(JSON.parse(body.toString("utf8")) as Record<string, unknown>);
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

// The slot database of the server, as the web app reads it
const onServer = <T>(fn: (db: Database.Database) => T): T => {
  const db = new Database(path.join(dataDir, String(slot), "messages.db"), { fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const serverState = (k: string) => onServer((db) => db.prepare("SELECT v FROM state WHERE k=?").pluck().get(k) as string | undefined);
// relay.db, written as the agent writes it
const inRelay = (sql: string, ...args: unknown[]) => {
  const db = new Database(path.join(relayDir, "relay.db"));
  try {
    db.prepare(sql).run(...args);
  } finally {
    db.close();
  }
};

beforeAll(async () => {
  const root = tempDir("teamsrelay-join-");
  dataDir = path.join(root, "data");
  relayDir = path.join(root, "relay");
  process.env.APP_DB = path.join(dataDir, "app.db");
  migrateAppSchema(appDb());
  ({ slot, token } = await addRelayAccount("owner-1", { db: appDb(), dataDir, slotCount: 4, perUser: 4 }));
  server = serve();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

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
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
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
    await until("the refusal", () => refused.includes(415));
    store.saveChats([{ name: "Luca Bianchi", preview: "ok", time: "13:00", unread: false, mention: false, muted: false, av: "" }]);
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
