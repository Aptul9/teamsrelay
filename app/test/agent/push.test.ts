import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import webpush from "web-push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "@/agent/config";
import { CALL_TTL, PUSH_TTL } from "@/agent/logic/notify";
import { Notifier } from "@/agent/push/notifier";
import { loadVapidKeys, type VapidKeys } from "@/agent/push/vapid";
import { AppStore } from "@/agent/store/app-store";
import { SlotStore } from "@/agent/store/slot-store";
import { migrateAppSchema, openAppDb } from "@/lib/appdb";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";
import { fakePushService } from "./fake-push";

const GEN = path.resolve(__dirname, "../../scripts/gen-vapid.mjs");

describe("VAPID keys", () => {
  it("are generated once and read back with the public key of appkey.txt", () => {
    const dir = path.join(tempDir(), "vapid");
    execFileSync(process.execPath, [GEN, dir], { stdio: "pipe" });
    const appKey = fs.readFileSync(path.join(dir, "appkey.txt"), "utf8");
    const keys = loadVapidKeys(path.join(dir, "private_key.pem"), path.join(dir, "appkey.txt"));
    expect(keys?.publicKey).toBe(appKey);
    expect(Buffer.from(appKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(keys?.privateKey ?? "", "base64url")).toHaveLength(32);
  });

  it("are never replaced", () => {
    const dir = path.join(tempDir(), "vapid");
    execFileSync(process.execPath, [GEN, dir], { stdio: "pipe" });
    const before = fs.readFileSync(path.join(dir, "private_key.pem"), "utf8");
    const again = spawnSync(process.execPath, [GEN, dir], { encoding: "utf8" });
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/not replaced/);
    expect(fs.readFileSync(path.join(dir, "private_key.pem"), "utf8")).toBe(before);
  });

  it("stop the agent when the private key does not match appkey.txt", () => {
    const [a, b] = [path.join(tempDir(), "a"), path.join(tempDir(), "b")];
    execFileSync(process.execPath, [GEN, a], { stdio: "pipe" });
    execFileSync(process.execPath, [GEN, b], { stdio: "pipe" });
    expect(() => loadVapidKeys(path.join(a, "private_key.pem"), path.join(b, "appkey.txt"))).toThrow(ConfigError);
  });

  it("leave push off without a private key", () => {
    expect(loadVapidKeys(path.join(tempDir(), "missing.pem"), path.join(tempDir(), "appkey.txt"))).toBeNull();
  });
});

// app.db with slots 1 (u1) and 2 (u2) and the given devices, as endpoint and subscription JSON
function seedAppDb(devices: [string, string, string][]) {
  const file = path.join(tempDir(), "app.db");
  const db = openAppDb(file);
  migrateAppSchema(db);
  db.prepare("INSERT INTO teams_accounts(slot, owner_id, added) VALUES(1, 'u1', 0), (2, 'u2', 0)").run();
  const add = db.prepare("INSERT INTO push_subscriptions VALUES(?, ?, ?, 0)");
  for (const [endpoint, user, sub] of devices) add.run(endpoint, user, sub);
  db.close();
  return file;
}

describe("notifier", () => {
  type Sent = { endpoint: string; payload: unknown; ttl: unknown; urgency: unknown };
  type Failure = { statusCode?: number; headers?: Record<string, string>; code?: string; message?: string };
  let sent: Sent[];
  // what the push service answers to the next sends to the phone, in order; then it takes them
  let failures: Failure[];
  let retries: { ms: number; run: () => void }[];
  let store: SlotStore;
  let appDbFile: string;
  const vapid: VapidKeys = { publicKey: "BPublic", privateKey: "private" };
  const sub = (endpoint: string) => JSON.stringify({ endpoint, keys: { p256dh: "k", auth: "a" } });

  beforeEach(() => {
    sent = [];
    failures = [];
    retries = [];
    store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
    appDbFile = seedAppDb([
      ["https://push/u1-phone", "u1", sub("https://push/u1-phone")],
      ["https://push/u1-gone", "u1", sub("https://push/u1-gone")],
      ["https://push/u2-phone", "u2", sub("https://push/u2-phone")],
    ]);
  });

  const notifier = (clock = () => 1_000_000) =>
    new Notifier({
      store,
      devices: new AppStore(appDbFile, 1),
      vapid,
      subject: "mailto:admin@example.com",
      ntfy: null,
      clock,
      later: (ms, run) => retries.push({ ms, run }),
      send: async (s, payload, options) => {
        if (s.endpoint.endsWith("gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
        const failure = failures.shift();
        if (failure) throw Object.assign(new Error("Received unexpected response code"), failure);
        sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload), ttl: options.TTL, urgency: options.urgency });
      },
    });

  // runs the first retry waiting, as its timer would, and lets it finish
  const retryNow = async () => {
    retries.shift()?.run();
    await new Promise((resolve) => setImmediate(resolve));
  };

  it("pushes to the devices of the owner, urgent, kept a day, and forgets the gone ones", async () => {
    expect(await notifier().push("Anna Rossi", "ciao")).toBe(1);
    expect(sent).toEqual([{ endpoint: "https://push/u1-phone", payload: { title: "Anna Rossi", body: "ciao", chat: "", acc: 1 }, ttl: PUSH_TTL, urgency: "high" }]);
    expect(PUSH_TTL).toBe(86_400);
    expect(retries).toEqual([]);
    const db = new Database(appDbFile, { readonly: true });
    expect(db.prepare("SELECT endpoint FROM push_subscriptions ORDER BY endpoint").pluck().all()).toEqual(["https://push/u1-phone", "https://push/u2-phone"]);
    db.close();
  });

  it("tells the agent when the web app runs its account only to check it", () => {
    expect(new AppStore(appDbFile, 1).checkedOnly()).toBe(false);
    const db = new Database(appDbFile);
    db.prepare("UPDATE teams_accounts SET check_every=3600 WHERE slot=1").run();
    db.close();
    expect(new AppStore(appDbFile, 1).checkedOnly()).toBe(true);
  });

  it("names the account when the owner has more", async () => {
    const db = new Database(appDbFile);
    db.prepare("INSERT INTO teams_accounts(slot, owner_id, added) VALUES(3, 'u1', 0)").run();
    db.close();
    store.setState(STATE.me, JSON.stringify({ name: "Anna", email: "anna@contoso.example", tenant: "Contoso", av: "" }));
    await notifier().push("Anna Rossi", "ciao");
    expect(sent[0].payload).toEqual({ title: "Anna Rossi · Contoso", body: "ciao", chat: "", acc: 1 });
  });

  it("tags a message with its chat, so the device keeps one notification per chat", async () => {
    await notifier().message("Anna Rossi", "are you there?", "Anna Rossi");
    expect(sent).toEqual([
      { endpoint: "https://push/u1-phone", payload: { title: "Anna Rossi", body: "are you there?", chat: "Anna Rossi", acc: 1, tag: "chat-1-Anna Rossi" }, ttl: PUSH_TTL, urgency: "high" },
    ]);
  });

  it("gives alerts a notification of their own", async () => {
    await notifier().alert("Teams signed out", "Sign in again");
    expect(sent[0].payload).toEqual({ title: "Teams signed out", body: "Sign in again", chat: "", acc: 1 });
  });

  it("pushes an incoming call on a notification of its own per account, kept only while it can be answered", async () => {
    const n = notifier();
    expect(await n.call("Anna Rossi", "ringing", 1_790_000_000_000)).toBe(1);
    await n.call("Anna Rossi", "ringing", 1_790_000_000_000);
    expect(sent).toEqual([
      {
        endpoint: "https://push/u1-phone",
        payload: { title: "Anna Rossi is calling", body: "Teams call, ringing now", chat: "", acc: 1, tag: "call-1", call: "ringing", ts: 1_790_000_000_000 },
        ttl: CALL_TTL,
        urgency: "high",
      },
      expect.objectContaining({ ttl: CALL_TTL }),
    ]);
    expect(CALL_TTL).toBe(60);
  });

  it("turns the call into a quiet one when it stops, kept a day, with the chat of the caller when known", async () => {
    store.saveChats([{ name: "Anna Rossi", preview: "", time: "", unread: false, mention: false, muted: false, av: "" }]);
    await notifier().call("Anna Rossi", "ended", 1_790_000_000_000, 9);
    expect(sent).toEqual([
      {
        endpoint: "https://push/u1-phone",
        payload: { title: "Call from Anna Rossi", body: "Ended after 9 s", chat: "Anna Rossi", acc: 1, tag: "call-1", call: "ended", ts: 1_790_000_000_000 },
        ttl: PUSH_TTL,
        urgency: "high",
      },
    ]);
  });

  it("says a call came when it could not read who calls, and names the account when the owner has more", async () => {
    const db = new Database(appDbFile);
    db.prepare("INSERT INTO teams_accounts(slot, owner_id, added) VALUES(3, 'u1', 0)").run();
    db.close();
    store.setState(STATE.me, JSON.stringify({ name: "Anna", email: "anna@contoso.example", tenant: "Contoso", av: "" }));
    const n = notifier();
    await n.call("", "ringing", 1_790_000_000_000);
    await n.call("", "ended", 1_790_000_000_000, 0);
    expect(sent.map((s) => [(s.payload as { title: string }).title, (s.payload as { body: string }).body])).toEqual([
      ["Incoming call · Contoso", "Teams call, ringing now"],
      ["Call ended · Contoso", "Ended"],
    ]);
  });

  it("does not try a ringing push again (the next one follows in seconds), an ended one yes", async () => {
    failures.push({ statusCode: 503 }, { statusCode: 503 });
    const n = notifier();
    await n.call("Anna Rossi", "ringing", 1_790_000_000_000);
    expect(retries).toEqual([]);
    await n.call("Anna Rossi", "ended", 1_790_000_000_000, 9);
    expect(retries.map((r) => r.ms)).toEqual([5000]);
  });

  it("rings an iPhone when the call starts and when it ends only: Safari there shows every push apart", async () => {
    appDbFile = seedAppDb([
      ["https://push/u1-phone", "u1", sub("https://push/u1-phone")],
      ["https://web.push.apple.com/QK1-iphone", "u1", sub("https://web.push.apple.com/QK1-iphone")],
    ]);
    const n = notifier();
    await n.call("Anna Rossi", "ringing", 1_790_000_000_000);
    await n.call("Anna Rossi", "again", 1_790_000_000_000);
    await n.call("Anna Rossi", "ended", 1_790_000_000_000, 9);
    const calls = (endpoint: string) => sent.filter((s) => s.endpoint === endpoint).map((s) => (s.payload as { call: string }).call);
    expect(calls("https://push/u1-phone")).toEqual(["ringing", "ringing", "ended"]);
    expect(calls("https://web.push.apple.com/QK1-iphone")).toEqual(["ringing", "ended"]);
  });

  it("sends to every device at once: a push service that does not answer holds no other", async () => {
    appDbFile = seedAppDb([
      ["https://0-slow/u1", "u1", sub("https://0-slow/u1")],
      ["https://push/u1-phone", "u1", sub("https://push/u1-phone")],
    ]);
    let release = () => {};
    const got: string[] = [];
    const n = new Notifier({
      store,
      devices: new AppStore(appDbFile, 1),
      vapid,
      subject: "mailto:admin@example.com",
      ntfy: null,
      send: async (s) => {
        if (s.endpoint.includes("slow")) await new Promise<void>((resolve) => (release = resolve));
        got.push(s.endpoint);
      },
    });
    const done = n.call("Anna Rossi", "ringing", 1_790_000_000_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(got).toEqual(["https://push/u1-phone"]);
    release();
    expect(await done).toBe(2);
  });

  it("keeps calls out of the history of notified messages", async () => {
    await notifier().call("Anna Rossi", "ringing", 1_790_000_000_000);
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    expect(db.prepare("SELECT COUNT(*) FROM messages").pluck().get()).toBe(0);
  });

  it("names the chat of a new message and records it once within 150 s", async () => {
    let now = 1_000_000;
    const n = notifier(() => now);
    await n.message("Anna Rossi", "are you there?", "Anna Rossi");
    now += 60_000;
    await n.message("Anna Rossi", "Are you there?", "Anna Rossi");
    expect(sent.map((s) => s.payload)).toEqual([{ title: "Anna Rossi", body: "are you there?", chat: "Anna Rossi", acc: 1, tag: "chat-1-Anna Rossi" }]);
    expect(store.lastNotificationTs()).toBeGreaterThan(0);
  });

  it("sends messages and alerts at high urgency, a check that passed at normal", async () => {
    const n = notifier();
    await n.message("Anna Rossi", "urgent?", "Anna Rossi");
    await n.alert("Teams signed out", "Sign in again");
    await n.alert("Teams OK", "Automatic check: the whole chain works.", "normal");
    expect(sent.map((s) => [(s.payload as { title: string }).title, s.urgency])).toEqual([
      ["Anna Rossi", "high"],
      ["Teams signed out", "high"],
      ["Teams OK", "normal"],
    ]);
    // alerts are about the relay, not messages: not in the history
    expect(store.lastNotificationTs()).toBeGreaterThan(0);
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    expect(db.prepare("SELECT title FROM messages").pluck().all()).toEqual(["Anna Rossi"]);
  });

  it("tries a push again when the push service fails or does not answer", async () => {
    failures.push({ statusCode: 503 }, { code: "ECONNRESET", message: "read ECONNRESET" }, { message: "Socket timeout" });
    expect(await notifier().push("Anna Rossi", "ciao")).toBe(0);
    expect(retries.map((r) => r.ms)).toEqual([5000]);
    await retryNow();
    expect(retries.map((r) => r.ms)).toEqual([30_000]);
    await retryNow();
    expect(retries.map((r) => r.ms)).toEqual([120_000]);
    await retryNow();
    expect(sent).toEqual([{ endpoint: "https://push/u1-phone", payload: { title: "Anna Rossi", body: "ciao", chat: "", acc: 1 }, ttl: PUSH_TTL, urgency: "high" }]);
    expect(retries).toEqual([]);
  });

  it("does not try again a push web-push refused before sending", async () => {
    failures.push({ message: "You must pass in a subscription with at least an endpoint." });
    expect(await notifier().push("Anna Rossi", "ciao")).toBe(0);
    expect(retries).toEqual([]);
  });

  it("drops a retry when the device is no longer the owner's", async () => {
    failures.push({ statusCode: 503 }, { statusCode: 503 });
    await notifier().push("Anna Rossi", "ciao");
    const db = new Database(appDbFile);
    db.prepare("UPDATE push_subscriptions SET user_id='u2' WHERE endpoint='https://push/u1-phone'").run();
    db.close();
    await retryNow();
    // the second answer is still waiting: nothing reached the push service
    expect(failures).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(retries).toEqual([]);
  });

  it("waits as long as a 429 asks, within 15 minutes", async () => {
    failures.push({ statusCode: 429, headers: { "retry-after": "42" } }, { statusCode: 429, headers: { "retry-after": "86400" } });
    await notifier().push("Anna Rossi", "ciao");
    expect(retries.map((r) => r.ms)).toEqual([42_000]);
    await retryNow();
    expect(retries.map((r) => r.ms)).toEqual([900_000]);
  });

  it("gives up after three retries", async () => {
    failures.push({ statusCode: 500 }, { statusCode: 502 }, { statusCode: 503 }, { statusCode: 504 });
    await notifier().push("Anna Rossi", "ciao");
    const waits: number[] = [];
    while (retries.length) {
      waits.push(retries[0].ms);
      await retryNow();
    }
    expect(waits).toEqual([5000, 30_000, 120_000]);
    expect(failures).toEqual([]);
    expect(sent).toEqual([]);
  });

  it.each([400, 401, 403, 413])("does not try again a push refused with %i", async (statusCode) => {
    failures.push({ statusCode });
    expect(await notifier().push("Anna Rossi", "ciao")).toBe(0);
    expect(retries).toEqual([]);
  });

  it("sends nothing without keys", async () => {
    const n = new Notifier({ store, devices: new AppStore(appDbFile, 1), vapid: null, subject: "mailto:a@b.c", ntfy: null });
    expect(await n.push("x", "y")).toBe(0);
  });
});

describe("notifier through web-push to a push service", () => {
  let service: Awaited<ReturnType<typeof fakePushService>>;
  let store: SlotStore;
  let appDbFile: string;
  const keys = webpush.generateVAPIDKeys();

  beforeEach(async () => {
    service = await fakePushService();
    store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
    const device = service.subscription();
    appDbFile = seedAppDb([[device.endpoint, "u1", JSON.stringify(device)]]);
  });

  afterEach(() => service.close());

  const notifier = (later?: (ms: number, run: () => void) => void) =>
    new Notifier({ store, devices: new AppStore(appDbFile, 1), vapid: keys, subject: "mailto:admin@example.com", ntfy: null, send: service.send, later });

  it("sends a message urgent, kept a day, without a topic, readable by the device only", async () => {
    await notifier().message("Anna Rossi", "ciao", "Anna Rossi");
    expect(service.received).toEqual([
      {
        payload: { title: "Anna Rossi", body: "ciao", chat: "Anna Rossi", acc: 1, tag: "chat-1-Anna Rossi" },
        ttl: "86400",
        urgency: "high",
        topic: undefined,
        vapid: expect.objectContaining({ sub: "mailto:admin@example.com", k: keys.publicKey }),
      },
    ]);
  });

  it("sends again after the Retry-After of a 429 and after a 503", async () => {
    const retries: { ms: number; run: () => void }[] = [];
    service.answer(429, { "Retry-After": "7" });
    service.answer(503);
    const n = notifier((ms, run) => retries.push({ ms, run }));
    expect(await n.push("TeamsRelay", "Teams session expired")).toBe(0);
    retries[0].run();
    await vi.waitFor(() => expect(retries).toHaveLength(2));
    retries[1].run();
    await vi.waitFor(() => expect(service.received).toHaveLength(3));
    expect(retries.map((r) => r.ms)).toEqual([7000, 30_000]);
    expect(service.received.map((r) => r.payload)).toEqual(Array(3).fill({ title: "TeamsRelay", body: "Teams session expired", chat: "", acc: 1 }));
  });
});
