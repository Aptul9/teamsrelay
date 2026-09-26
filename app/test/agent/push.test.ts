import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "@/agent/config";
import { PUSH_TTL } from "@/agent/logic/notify";
import { Notifier } from "@/agent/push/notifier";
import { loadVapidKeys, type VapidKeys } from "@/agent/push/vapid";
import { AppStore } from "@/agent/store/app-store";
import { SlotStore } from "@/agent/store/slot-store";
import { migrateAppSchema, openAppDb } from "@/lib/appdb";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

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

describe("notifier", () => {
  type Sent = { endpoint: string; payload: unknown; ttl: unknown; urgency: unknown };
  let sent: Sent[];
  let store: SlotStore;
  let appDbFile: string;
  const vapid: VapidKeys = { publicKey: "BPublic", privateKey: "private" };
  const sub = (endpoint: string) => JSON.stringify({ endpoint, keys: { p256dh: "k", auth: "a" } });

  beforeEach(() => {
    sent = [];
    store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
    appDbFile = path.join(tempDir(), "app.db");
    const db = openAppDb(appDbFile);
    migrateAppSchema(db);
    db.prepare("INSERT INTO teams_accounts(slot, owner_id, added) VALUES(1, 'u1', 0), (2, 'u2', 0)").run();
    db.prepare("INSERT INTO push_subscriptions VALUES(?, 'u1', ?, 0), (?, 'u1', ?, 0), (?, 'u2', ?, 0)").run(
      "https://push/u1-phone",
      sub("https://push/u1-phone"),
      "https://push/u1-gone",
      sub("https://push/u1-gone"),
      "https://push/u2-phone",
      sub("https://push/u2-phone"),
    );
    db.close();
  });

  const notifier = (clock = () => 1_000_000) =>
    new Notifier({
      store,
      devices: new AppStore(appDbFile, 1),
      vapid,
      subject: "mailto:admin@example.com",
      ntfy: null,
      clock,
      send: async (s, payload, options) => {
        if (s.endpoint.endsWith("gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
        sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload), ttl: options.TTL, urgency: options.urgency });
      },
    });

  it("pushes to the devices of the owner with a TTL of one hour and forgets the gone ones", async () => {
    expect(await notifier().push("Anna Rossi", "ciao")).toBe(1);
    expect(sent).toEqual([{ endpoint: "https://push/u1-phone", payload: { title: "Anna Rossi", body: "ciao", chat: "", acc: 1 }, ttl: PUSH_TTL, urgency: "high" }]);
    expect(PUSH_TTL).toBe(3600);
    const db = new Database(appDbFile, { readonly: true });
    expect(db.prepare("SELECT endpoint FROM push_subscriptions ORDER BY endpoint").pluck().all()).toEqual(["https://push/u1-phone", "https://push/u2-phone"]);
    db.close();
  });

  it("names the account when the owner has more", async () => {
    const db = new Database(appDbFile);
    db.prepare("INSERT INTO teams_accounts(slot, owner_id, added) VALUES(3, 'u1', 0)").run();
    db.close();
    store.setState(STATE.me, JSON.stringify({ name: "Anna", email: "anna@contoso.example", tenant: "Contoso", av: "" }));
    await notifier().push("Anna Rossi", "ciao");
    expect(sent[0].payload).toEqual({ title: "Anna Rossi · Contoso", body: "ciao", chat: "", acc: 1 });
  });

  it("names the chat of a new message and records it once within 150 s", async () => {
    let now = 1_000_000;
    const n = notifier(() => now);
    await n.message("Anna Rossi", "are you there?");
    now += 60_000;
    await n.message("Anna Rossi", "Are you there?");
    expect(sent.map((s) => s.payload)).toEqual([{ title: "Anna Rossi", body: "are you there?", chat: "Anna Rossi", acc: 1 }]);
    expect(store.lastNotificationTs()).toBeGreaterThan(0);
  });

  it("sends messages and alerts at high urgency, a check that passed at normal", async () => {
    const n = notifier();
    await n.message("Anna Rossi", "urgent?");
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

  it("sends nothing without keys", async () => {
    const n = new Notifier({ store, devices: new AppStore(appDbFile, 1), vapid: null, subject: "mailto:a@b.c", ntfy: null });
    expect(await n.push("x", "y")).toBe(0);
  });
});
