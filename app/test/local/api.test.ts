import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SlotStore } from "@/agent/store/slot-store";
import { RelayDevices } from "@/local/devices";
import { apiHandler, Failures } from "@/local/server";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

const TOKEN = "t".repeat(32);
const WEB = path.resolve(__dirname, "../../src/local/web");
const PUBLIC = path.resolve(__dirname, "../../public");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let store: SlotStore;
let devices: RelayDevices;
let server: http.Server;
let base = "";
let mediaDir = "";

const now = () => Math.floor(Date.now() / 1000);
const setHealth = (h: object) => store.setState(STATE.health, JSON.stringify({ browser: "ok", overall: "green", ts: now(), ...h }));

// the API on a free port; `failures` decides after how many wrong tokens an address gets 429
async function serve(failures = new Failures(100)) {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  server = http.createServer(apiHandler({ store, devices, token: TOKEN, vapidKey: "BPublicKey", webDir: WEB, publicDir: PUBLIC, mediaDir, commandWaitMs: 1500 }, failures));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  const dir = tempDir();
  mediaDir = path.join(dir, "media");
  fs.mkdirSync(mediaDir);
  store = SlotStore.open(path.join(dir, "relay.db"));
  devices = RelayDevices.open(path.join(dir, "relay.db"));
  await serve();
});

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(p: string, o: { method?: string; body?: unknown; token?: string | null; raw?: string; type?: string } = {}) {
  const headers: Record<string, string> = {};
  if (o.token !== null) headers.Authorization = `Bearer ${o.token ?? TOKEN}`;
  if (o.body !== undefined || o.raw !== undefined) headers["Content-Type"] = o.type ?? "application/json";
  const r = await fetch(base + p, { method: o.method ?? "GET", headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: static files
  }
  return { status: r.status, headers: r.headers, json, text };
}

describe("app files", () => {
  it("serves the page with a policy that loads nothing from outside", async () => {
    const r = await call("/", { token: null });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/html/);
    expect(r.headers.get("content-security-policy")).toMatch(/default-src 'none'.*script-src 'self'.*connect-src 'self'.*frame-ancestors 'none'/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    for (const f of ["/app.js", "/app.css", "/sw.js", "/manifest.webmanifest", "/static/icon-180.png", "/static/icon-192.png", "/static/icon-512.png"]) {
      expect((await call(f, { token: null })).status, f).toBe(200);
    }
  });

  it("serves nothing else from the disk", async () => {
    for (const p of ["/package.json", "/../package.json", "/%2e%2e/package.json", "/src/local/web/app.js", "/static/../relay.env", "/state/token", "/public/sw.js"]) {
      expect((await call(p, { token: null })).status, p).toBe(404);
    }
  });

  it("answers the liveness and the public push key without a token", async () => {
    expect((await call("/healthz", { token: null })).json).toEqual({ ok: true });
    expect((await call("/api/vapid", { token: null })).json).toEqual({ key: "BPublicKey" });
  });
});

// A request as it comes off the wire, whatever its target: fetch() refuses to send what is not a URL
function raw(target: string): Promise<string> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`GET ${target} HTTP/1.1\r\nHost: relay\r\nConnection: close\r\n\r\n`));
    let data = "";
    s.on("data", (d) => (data += String(d)));
    s.on("end", () => resolve(data));
    s.on("error", reject);
    s.setTimeout(5000, () => s.destroy(new Error(`no answer to GET ${target}`)));
  });
}

describe("request target", () => {
  it("answers 400 to a target that is not a URL, before the token, and goes on serving", async () => {
    for (const target of ["//[", "//x:y:z", "/%"]) expect(await raw(target), target).toMatch(/^HTTP\/1\.1 (400|404)/);
    expect(await raw("//[")).toMatch(/^HTTP\/1\.1 400/);
    expect((await call("/healthz", { token: null })).json).toEqual({ ok: true });
  });
});

describe("token", () => {
  it("is required on every API call and every image", async () => {
    for (const p of ["/api/state", "/api/messages?chat=x", "/api/cmd/1", "/media/0123456789abcdef.png"]) {
      expect((await call(p, { token: null })).status, p).toBe(401);
      expect((await call(p, { token: "wrong" })).status, p).toBe(401);
    }
  });

  // behind tailscale serve every phone comes from 127.0.0.1: a few typos must not lock out the owner
  it("limits wrong tokens only: after too many, wrong ones get 429 and the right one still gets in", async () => {
    await serve(new Failures(3));
    for (let i = 0; i < 3; i++) expect((await call("/api/state", { token: "wrong" })).status).toBe(401);
    expect((await call("/api/state", { token: "wrong again" })).status).toBe(429);
    expect((await call("/api/state")).status).toBe(200);
    expect((await call("/api/state", { token: null })).status).toBe(429);
  });
});

describe("state and messages", () => {
  it("gives health, account, chats and devices", async () => {
    setHealth({ teams: "ok", watcher: "ok" });
    store.setState(STATE.me, JSON.stringify({ name: "Test User", email: "test.user@contoso.example", tenant: "Contoso", av: "abc.png" }));
    store.saveChats([{ name: "Anna Rossi", preview: "ciao", time: "10:30", unread: true, mention: false, muted: false, av: "0123456789abcdef.png" }]);
    const r = await call("/api/state");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.json).toMatchObject({
      health: { teams: "ok", agent: "ok", overall: "green" },
      me: { name: "Test User", email: "test.user@contoso.example", tenant: "Contoso" },
      chats: [{ name: "Anna Rossi", preview: "ciao", time: "10:30", unread: true, mention: false, muted: false }],
      devices: 0,
      push: true,
    });
  });

  it("says the agent is not answering when its health is older than a minute", async () => {
    store.setState(STATE.health, JSON.stringify({ browser: "ok", teams: "ok", overall: "green", ts: now() - 61 }));
    expect((await call("/api/state")).json.health).toMatchObject({ agent: "stale", teams: "unknown", overall: "red" });
  });

  it("gives the messages as text, and keeps the chat Teams has open while the app looks at it", async () => {
    store.saveChatMessages("Anna Rossi", [
      { mid: "1", author: "Anna Rossi", text: "<b>hi</b>", mine: false, reacts: "", extra: { html: "<b>hi</b><img src=x onerror=alert(1)>", images: [{ f: "0123456789abcdef.png", w: 10, h: 10 }] } },
      { mid: "2", author: "", text: "ok", mine: true, reacts: "👍", extra: { status: "Seen", reactions: [{ e: "👍", n: 1, mine: false }] } },
    ]);
    let r = await call(`/api/messages?chat=${encodeURIComponent("Anna Rossi")}`);
    expect(r.json.open).toBe(false);
    expect(store.getState(STATE.viewing)).toBe("");
    expect(r.json.messages).toEqual([
      { mid: "1", author: "Anna Rossi", text: "<b>hi</b>", mine: false, quote: null, images: [{ f: "0123456789abcdef.png", w: 10, h: 10 }], files: [], reactions: [], status: "", edited: false, deleted: false, mentionsMe: false },
      { mid: "2", author: "", text: "ok", mine: true, quote: null, images: [], files: [], reactions: [{ e: "👍", n: 1, mine: false }], status: "Seen", edited: false, deleted: false, mentionsMe: false },
    ]);
    expect(r.text).not.toContain("onerror");
    store.setState(STATE.activeChat, "Anna Rossi");
    r = await call(`/api/messages?chat=${encodeURIComponent("Anna Rossi")}`);
    expect(r.json.open).toBe(true);
    expect(JSON.parse(store.getState(STATE.viewing))).toEqual({ chat: "Anna Rossi", ts: expect.any(Number) });
    expect((await call("/api/messages")).status).toBe(400);
  });

  it("serves the saved images by their name only", async () => {
    fs.writeFileSync(path.join(mediaDir, "0123456789abcdef.png"), PNG);
    const r = await call("/media/0123456789abcdef.png");
    expect([r.status, r.headers.get("content-type")]).toEqual([200, "image/png"]);
    for (const p of ["/media/0123456789abcdef.webp", "/media/..%2Frelay.db", "/media/token", "/media/0123456789ABCDEF.png"]) expect((await call(p)).status, p).toBe(404);
  });
});

describe("commands", () => {
  beforeEach(() => setHealth({ teams: "ok" }));

  // stands in for the agent: finishes every pending command after `ms`. On the store of its own test, and stopped
  // whole: a finish left for later would end a command of the next test, whose ids start at 1 again.
  function agentFinishing(status: "done" | "failed", ms = 200) {
    const s = store;
    const later = new Set<NodeJS.Timeout>();
    const timer = setInterval(() => {
      for (const c of s.pendingCommands()) later.add(setTimeout(() => s.finishCommand(c.id, status), ms));
    }, 50);
    return () => {
      clearInterval(timer);
      for (const t of later) clearTimeout(t);
    };
  }

  it("queues each command as the agent reads it and answers its outcome", async () => {
    const stop = agentFinishing("done");
    try {
      const cases: [object, string, string, string][] = [
        [{ type: "open", chat: "Anna Rossi" }, "open", "Anna Rossi", ""],
        [{ type: "send", chat: "Anna Rossi", text: "hello\nworld" }, "send", "Anna Rossi", "hello\nworld"],
        [{ type: "reply", chat: "Anna Rossi", mid: "1", text: "On it" }, "reply", "Anna Rossi", '{"mid":"1","text":"On it"}'],
        [{ type: "edit", chat: "Anna Rossi", mid: "2", text: "fixed" }, "edit", "Anna Rossi", '{"mid":"2","text":"fixed"}'],
        [{ type: "delete", chat: "Anna Rossi", mid: "2" }, "delete", "Anna Rossi", '{"mid":"2"}'],
        [{ type: "undodelete", chat: "Anna Rossi", mid: "2" }, "undodelete", "Anna Rossi", '{"mid":"2"}'],
        [{ type: "react", chat: "Anna Rossi", mid: "1", emoji: "heart" }, "react", "Anna Rossi", '{"mid":"1","emoji":"heart"}'],
        [{ type: "react", chat: "Anna Rossi", mid: "1", pill: "👍" }, "react", "Anna Rossi", '{"mid":"1","pill":"👍"}'],
        [{ type: "recheck" }, "recheck", "", ""],
      ];
      for (const [body, type, arg1, arg2] of cases) {
        const r = await call("/api/cmd", { method: "POST", body });
        expect(r.json, JSON.stringify(body)).toEqual({ id: expect.any(Number), status: "done" });
        const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
        expect(db.prepare("SELECT type, arg1, arg2 FROM commands WHERE id=?").get(r.json.id)).toEqual({ type, arg1, arg2 });
      }
    } finally {
      stop();
    }
  });

  it("waits while the agent runs the command, and answers its outcome", async () => {
    const s = store;
    const timer = setInterval(() => {
      for (const c of s.pendingCommands()) {
        s.startCommand(c.id);
        setTimeout(() => s.finishCommand(c.id, "done"), 300);
      }
    }, 50);
    try {
      const r = await call("/api/cmd", { method: "POST", body: { type: "send", chat: "Anna Rossi", text: "hi" } });
      expect(r.json).toEqual({ id: expect.any(Number), status: "done" });
    } finally {
      clearInterval(timer);
    }
  });

  it("answers pending when Teams takes longer, and the outcome later", async () => {
    const stop = agentFinishing("failed", 2500);
    try {
      const r = await call("/api/cmd", { method: "POST", body: { type: "send", chat: "Anna Rossi", text: "hi" } });
      expect(r.json.status).toBe("pending");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect((await call(`/api/cmd/${r.json.id}`)).json).toEqual({ id: r.json.id, status: "failed" });
      expect((await call("/api/cmd/99999")).status).toBe(404);
    } finally {
      stop();
    }
  });

  it("queues a command once per key: sent again after a lost answer, it is the same command", async () => {
    const stop = agentFinishing("done", 300);
    try {
      const body = { type: "send", chat: "Anna Rossi", text: "only once", key: "a1b2c3d4e5f6a7b8" };
      const [first, again] = await Promise.all([call("/api/cmd", { method: "POST", body }), call("/api/cmd", { method: "POST", body })]);
      expect(again.json).toEqual(first.json);
      expect(first.json.status).toBe("done");
      const later = await call("/api/cmd", { method: "POST", body });
      expect(later.json).toEqual(first.json);
      const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
      expect(db.prepare("SELECT COUNT(*) FROM commands WHERE arg2='only once'").pluck().get()).toBe(1);
    } finally {
      stop();
    }
  });

  it("refuses a key that is not one, without queueing anything", async () => {
    for (const key of ["short", "has spaces in it", "x".repeat(65), 12345678, "semi;colon;semi;colon"]) {
      const r = await call("/api/cmd", { method: "POST", body: { type: "send", chat: "Anna Rossi", text: "hi", key } });
      expect(r.status, String(key)).toBe(400);
    }
    expect(store.hasPendingCommands()).toBe(false);
  });

  it("refuses what is not a command, without queueing it", async () => {
    const bad: [object | string, number][] = [
      [{ type: "teleport", chat: "Anna Rossi" }, 400],
      [{ type: "send", text: "no chat" }, 400],
      [{ type: "send", chat: "Anna Rossi", text: "   " }, 400],
      [{ type: "send", chat: "x".repeat(201), text: "hi" }, 400],
      [{ type: "send", chat: "Anna Rossi", text: "x".repeat(20001) }, 400],
      [{ type: "reply", chat: "Anna Rossi", text: "no mid" }, 400],
      [{ type: "react", chat: "Anna Rossi", mid: "1", emoji: "thumbsdown" }, 400],
      [[1, 2], 400],
      ["{not json", 400],
    ];
    for (const [body, status] of bad) {
      const r = await call("/api/cmd", { method: "POST", ...(typeof body === "string" ? { raw: body } : { body }) });
      expect(r.status, JSON.stringify(body)).toBe(status);
    }
    expect((await call("/api/cmd", { method: "POST", raw: "type=send", type: "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await call("/api/cmd", { method: "POST", raw: JSON.stringify({ type: "send", chat: "a", text: "x".repeat(70_000) }) })).status).toBe(413);
    expect(store.hasPendingCommands()).toBe(false);
  });

  it("refuses commands while Teams is signed out or the relay is not reading it", async () => {
    setHealth({ teams: "login", overall: "red" });
    let r = await call("/api/cmd", { method: "POST", body: { type: "send", chat: "Anna Rossi", text: "hi" } });
    expect([r.status, r.json.detail]).toEqual([409, "Teams is signed out: sign in again in the relay window"]);
    setHealth({ browser: "down", teams: "err", overall: "red" });
    expect((await call("/api/cmd", { method: "POST", body: { type: "resync" } })).status).toBe(503);
    store.setState(STATE.health, JSON.stringify({ browser: "ok", teams: "ok", overall: "green", ts: now() - 120 }));
    r = await call("/api/cmd", { method: "POST", body: { type: "resync" } });
    expect(r.status).toBe(503);
    expect(store.hasPendingCommands()).toBe(false);
  });
});

describe("push subscriptions", () => {
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", expirationTime: null, keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } };

  it("keeps the device a browser subscribed, once, and forgets it on request", async () => {
    expect((await call("/api/push", { method: "POST", body: sub })).json).toEqual({ ok: true, devices: 1 });
    expect((await call("/api/push", { method: "POST", body: sub })).json).toEqual({ ok: true, devices: 1 });
    expect(JSON.parse(devices.targets()[0].sub)).toEqual({ endpoint: sub.endpoint, keys: sub.keys });
    expect((await call("/api/push", { method: "DELETE", body: { endpoint: sub.endpoint } })).json).toEqual({ ok: true, devices: 0 });
  });

  it("refuses what is not a subscription", async () => {
    for (const body of [{ ...sub, endpoint: "http://fcm.googleapis.com/x" }, { ...sub, keys: { p256dh: "<script>", auth: "a".repeat(22) } }, { endpoint: sub.endpoint }]) {
      expect((await call("/api/push", { method: "POST", body })).status, JSON.stringify(body)).toBe(400);
    }
    expect(devices.count()).toBe(0);
  });
});
