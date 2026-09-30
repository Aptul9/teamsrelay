// A notification of an account on another computer (src/lib/relay.ts) reaches the phones of the Android app of its
// owner, as the notifications of an account of the browsers container do: through FCM once the service account key of
// the Firebase project is there (FCM_CREDENTIALS), sealed with the key of each phone. Google is answered by the test.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as registerPhone } from "@/app/api/push/fcm/route";
import { appDb, migrateAppSchema } from "@/lib/appdb";
import { auth, authOptions } from "@/lib/auth";
import { relayPush, requireRelay } from "@/lib/relay";
import { addRelayAccount } from "@/lib/slots";
import { syncEnvAdmin } from "@/server/env-admin";
import { tempDir } from "./helpers";

// appDb() and auth() are created on first use, after this file has set the environment
const dir = tempDir();
process.env.APP_DB = path.join(dir, "app.db");
process.env.BETTER_AUTH_SECRET = "test-secret-0123456789-0123456789-0123456789";
process.env.DOMAIN = "http://localhost:8090";
process.env.ADMIN_EMAIL = "admin@example.test";
process.env.ADMIN_PASSWORD = "first-password-1";
// no push keys of the server: Web Push stays off, the phones get the notifications through FCM alone
process.env.VAPID_PRIVATE = path.join(dir, "vapid", "private_key.pem");
process.env.VAPID_APPKEY = path.join(dir, "vapid", "appkey.txt");

const keyFile = path.join(dir, "fcm", "service-account.json");
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
fs.mkdirSync(path.dirname(keyFile), { recursive: true });
fs.writeFileSync(
  keyFile,
  JSON.stringify({
    type: "service_account",
    project_id: "teamsrelay-test",
    client_email: "relay@teamsrelay-test.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    token_uri: "https://oauth2.googleapis.com/token",
  }),
);

type FcmMessage = { token: string; data: Record<string, string>; android: { priority: string; ttl: string } };

// Google as the test answers it: the OAuth token endpoint, and FCM taking every message
function google() {
  const sent: { url: string; body: string }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    sent.push({ url: u, body: String(init?.body ?? "") });
    if (u === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "token-1", expires_in: 3599, token_type: "Bearer" });
    if (u.startsWith("https://fcm.googleapis.com/")) return Response.json({ name: "projects/teamsrelay-test/messages/1" });
    return new Response("not a Google endpoint", { status: 500 });
  });
  return (token: string) =>
    sent.filter((s) => s.url.startsWith("https://fcm.googleapis.com/")).map((s) => (JSON.parse(s.body) as { message: FcmMessage }).message).filter((m) => m.token === token);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// The content of an FCM message, opened with the key of the phone as the app does (Seal.kt)
function open(key: string, data: Record<string, string>): Record<string, unknown> {
  const ct = Buffer.from(data.ct, "base64url");
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key, "base64url"), Buffer.from(data.iv, "base64url"));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8")) as Record<string, unknown>;
}

let owner = "";
let cookie = "";

beforeAll(async () => {
  const { runMigrations } = await getMigrations(authOptions());
  await runMigrations();
  migrateAppSchema(appDb());
  await syncEnvAdmin();
  const { headers } = await auth().api.signInEmail({ body: { email: "admin@example.test", password: "first-password-1" }, returnHeaders: true });
  cookie = headers.get("set-cookie")!.split(";")[0];
  owner = appDb().prepare('SELECT id FROM "user" WHERE email=?').pluck().get("admin@example.test") as string;
});

// A phone of the owner, registered as the app registers it; its key opens what the server sends it
async function phone(token: string): Promise<string> {
  const res = await registerPhone(
    new Request("http://localhost:8090/api/push/fcm", { method: "POST", body: JSON.stringify({ token, name: "Google Pixel 9" }), headers: { "Content-Type": "application/json", cookie } }),
    undefined,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { key: string }).key;
}

// A new account of the owner on another computer, and the caller its relay's requests come as
async function relayAccount() {
  const { slot, token } = await addRelayAccount(owner, { db: appDb(), dataDir: dir, slotCount: 8, perUser: 8 });
  return { slot, caller: requireRelay(new Request("http://localhost:8090/api/relay/push", { headers: { Authorization: `Bearer ${token}` } })) };
}

describe("a notification of an account on another computer", () => {
  it("reaches the phones of the Android app of its owner through FCM, sealed with the key of each phone", async () => {
    process.env.FCM_CREDENTIALS = keyFile;
    const sentTo = google();
    const key = await phone("phone-token-relay-message-aaaa");
    const { slot, caller } = await relayAccount();
    expect(await relayPush(caller, { op: "message", title: "Anna Rossi", body: "Are you there?", chat: "Anna Rossi" })).toBeGreaterThanOrEqual(1);
    const [m] = sentTo("phone-token-relay-message-aaaa");
    expect(m).toMatchObject({ android: { priority: "HIGH" } });
    expect(open(key, m.data)).toMatchObject({ body: "Are you there?", chat: "Anna Rossi", acc: slot });
  });

  it("rings the phones for a call with Answer: its relay takes the call in Teams there, the sound stays on that computer", async () => {
    process.env.FCM_CREDENTIALS = keyFile;
    const sentTo = google();
    const key = await phone("phone-token-relay-call-bbbbbbb");
    const { slot, caller } = await relayAccount();
    await relayPush(caller, { op: "call", caller: "Anna Rossi", state: "ringing", since: 1_790_000_000_000, seconds: 0 });
    const [m] = sentTo("phone-token-relay-call-bbbbbbb");
    const content = open(key, m.data);
    expect(content).toMatchObject({ call: "ringing", ts: 1_790_000_000_000, acc: slot, answer: true });
  });

  it("goes to no phone while the server has no service account key, and forgets none", async () => {
    process.env.FCM_CREDENTIALS = path.join(dir, "fcm", "missing.json");
    const sentTo = google();
    await phone("phone-token-relay-nokey-cccccc");
    const { caller } = await relayAccount();
    await relayPush(caller, { op: "message", title: "Anna Rossi", body: "Still there?", chat: "" });
    expect(sentTo("phone-token-relay-nokey-cccccc")).toEqual([]);
    expect(appDb().prepare("SELECT COUNT(*) FROM push_subscriptions WHERE endpoint=?").pluck().get("fcm:phone-token-relay-nokey-cccccc")).toBe(1);
  });

  it("goes out without FCM when the key file is not a service account key", async () => {
    const bad = path.join(dir, "fcm", "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ project_info: {} }));
    process.env.FCM_CREDENTIALS = bad;
    const sentTo = google();
    await phone("phone-token-relay-badkey-dddddd");
    const { caller } = await relayAccount();
    await expect(relayPush(caller, { op: "alert", title: "Teams signed out", body: "Sign in on the other computer", urgency: "high" })).resolves.toBe(0);
    expect(sentTo("phone-token-relay-badkey-dddddd")).toEqual([]);
  });
});
