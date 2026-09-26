import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PUSH_TTL } from "@/agent/logic/notify";
import { Notifier } from "@/agent/push/notifier";
import { loadVapidKeys, type VapidKeys } from "@/agent/push/vapid";
import { SlotStore } from "@/agent/store/slot-store";
import { ConfigError } from "@/relay/config";
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

  it("stop the relay when the private key does not match appkey.txt", () => {
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
  type Sent = { endpoint: string; payload: unknown; ttl: unknown };
  let sent: Sent[];
  let store: SlotStore;
  const vapid: VapidKeys = { publicKey: "BPublic", privateKey: "private" };
  const sub = (endpoint: string) => JSON.stringify({ endpoint, keys: { p256dh: "k", auth: "a" } });

  beforeEach(() => {
    sent = [];
    store = SlotStore.open(path.join(tempDir(), "relay.db"));
    for (const e of ["https://push.example/phone", "https://push.example/gone", "https://push.example/pc"]) store.savePushSubscription(e, sub(e), "test");
  });

  const notifier = (clock = () => 1_000_000) =>
    new Notifier({
      store,
      vapid,
      subject: "mailto:admin@example.com",
      ntfy: null,
      clock,
      send: async (s, payload, options) => {
        if (s.endpoint.endsWith("gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
        sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload), ttl: options.TTL });
      },
    });

  it("pushes to every device with a TTL of one hour and forgets the gone ones", async () => {
    expect(await notifier().push("Teams back", "Signed in again")).toBe(2);
    expect(sent).toEqual([
      { endpoint: "https://push.example/phone", payload: { title: "Teams back", body: "Signed in again", chat: "" }, ttl: PUSH_TTL },
      { endpoint: "https://push.example/pc", payload: { title: "Teams back", body: "Signed in again", chat: "" }, ttl: PUSH_TTL },
    ]);
    expect(PUSH_TTL).toBe(3600);
    expect(store.pushSubscriptions().map((s) => s.endpoint)).toEqual(["https://push.example/phone", "https://push.example/pc"]);
  });

  it("names the chat of a new message, so the notification opens it, and records it once within 150 s", async () => {
    let now = 1_000_000;
    const n = notifier(() => now);
    await n.message("Anna Rossi", "are you there?");
    now += 60_000;
    await n.message("Anna Rossi", "Are you there?");
    expect(sent.map((s) => s.payload)).toEqual([
      { title: "Anna Rossi", body: "are you there?", chat: "Anna Rossi" },
      { title: "Anna Rossi", body: "are you there?", chat: "Anna Rossi" },
    ]);
    expect(store.lastNotificationTs()).toBeGreaterThan(0);
  });

  it("sends nothing without keys or without devices", async () => {
    const n = new Notifier({ store, vapid: null, subject: "mailto:a@b.c", ntfy: null });
    expect(await n.push("x", "y")).toBe(0);
    const empty = SlotStore.open(path.join(tempDir(), "relay.db"));
    expect(await new Notifier({ store: empty, vapid, subject: "mailto:a@b.c", ntfy: null, send: async () => sent.push({} as Sent) }).alert("x", "y")).toBe(0);
    expect(sent).toEqual([]);
  });
});
