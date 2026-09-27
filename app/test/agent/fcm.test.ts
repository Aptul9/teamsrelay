// FCM HTTP v1 as the relay speaks it to the phones of the Android app: OAuth token of the service account, one data
// message per phone, its content sealed with the key of the phone. The Google endpoints are answered by the test.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "@/agent/config";
import { FcmSender, loadServiceAccount, newDeviceKey, sealFor } from "@/agent/push/fcm";
import { tempDir } from "../helpers";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const sa = {
  project_id: "teamsrelay-test",
  client_email: "relay@teamsrelay-test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.googleapis.com/token",
};

type Sent = { url: string; headers: Record<string, string>; body: string };

// Google as the test answers it: the token endpoint, then FCM with the given answers in order (200 once they run out)
function google(answers: { status: number; body?: unknown; headers?: Record<string, string> }[] = []) {
  const sent: Sent[] = [];
  let tokens = 0;
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    if (url === sa.token_uri) return Response.json({ access_token: `token-${++tokens}`, expires_in: 3599, token_type: "Bearer" });
    const a = answers.shift() ?? { status: 200, body: { name: "projects/teamsrelay-test/messages/1" } };
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers: a.headers });
  };
  return { sent, fetch, fcm: () => sent.filter((s) => s.url.includes("fcm.googleapis.com")) };
}

describe("FCM sender", () => {
  it("signs in as the service account with a JWT and keeps the access token until shortly before it ends", async () => {
    let now = 1_790_000_000_000;
    const g = google();
    const sender = new FcmSender(sa, { fetch: g.fetch, clock: () => now });
    await sender.send("phone-token-1234567890", { v: "1" }, { ttl: 60, high: true });
    await sender.send("phone-token-1234567890", { v: "1" }, { ttl: 60, high: true });
    const tokenCalls = g.sent.filter((s) => s.url === sa.token_uri);
    expect(tokenCalls).toHaveLength(1);
    const form = new URLSearchParams(tokenCalls[0].body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [head, claims, signature] = form.get("assertion")!.split(".");
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: sa.token_uri,
      iat: 1_790_000_000,
      exp: 1_790_003_600,
    });
    expect(crypto.verify("RSA-SHA256", Buffer.from(`${head}.${claims}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    now += 3300 * 1000;
    await sender.send("phone-token-1234567890", { v: "1" }, { ttl: 60, high: true });
    expect(g.sent.filter((s) => s.url === sa.token_uri)).toHaveLength(2);
    expect(g.fcm().map((s) => s.headers.Authorization)).toEqual(["Bearer token-1", "Bearer token-1", "Bearer token-2"]);
  });

  it("sends a data message only, with the Android priority and the time the service keeps it, and no collapse key", async () => {
    const g = google();
    const sender = new FcmSender(sa, { fetch: g.fetch });
    expect(await sender.send("phone-token-1234567890", { v: "1", iv: "x", ct: "y" }, { ttl: 86400, high: false })).toEqual({ ok: true });
    const [m] = g.fcm();
    expect(m.url).toBe("https://fcm.googleapis.com/v1/projects/teamsrelay-test/messages:send");
    expect(JSON.parse(m.body)).toEqual({ message: { token: "phone-token-1234567890", data: { v: "1", iv: "x", ct: "y" }, android: { priority: "NORMAL", ttl: "86400s" } } });
  });

  it("tells a token that no longer exists from a failure worth another try", async () => {
    const g = google([
      { status: 404, body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } },
      { status: 400, body: { error: { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } } },
      { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } }, headers: { "Retry-After": "90" } },
      { status: 503, body: { error: { status: "UNAVAILABLE" } } },
    ]);
    const sender = new FcmSender(sa, { fetch: g.fetch });
    const send = () => sender.send("phone-token-1234567890", { v: "1" }, { ttl: 60, high: true });
    expect(await send()).toEqual({ ok: false, status: 404, gone: true });
    expect(await send()).toEqual({ ok: false, status: 400, gone: true });
    expect(await send()).toEqual({ ok: false, status: 429, gone: false, retryAfter: "90" });
    expect(await send()).toEqual({ ok: false, status: 503, gone: false });
  });

  it("asks for a new access token once when FCM refuses the one it has", async () => {
    const g = google([{ status: 401, body: { error: { status: "UNAUTHENTICATED" } } }]);
    const sender = new FcmSender(sa, { fetch: g.fetch });
    expect(await sender.send("phone-token-1234567890", { v: "1" }, { ttl: 60, high: true })).toEqual({ ok: true });
    expect(g.fcm().map((s) => s.headers.Authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });
});

describe("sealed content", () => {
  it("opens with the key of the phone only (AES-256-GCM, ciphertext followed by the tag)", () => {
    const key = newDeviceKey();
    expect(Buffer.from(key, "base64url")).toHaveLength(32);
    const data = sealFor(key, { title: "Anna Rossi is calling", acc: 2 });
    expect(Object.keys(data).sort()).toEqual(["ct", "iv", "v"]);
    expect(data.v).toBe("1");
    const open = (k: string) => {
      const ct = Buffer.from(data.ct, "base64url");
      const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(k, "base64url"), Buffer.from(data.iv, "base64url"));
      d.setAuthTag(ct.subarray(ct.length - 16));
      return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString();
    };
    expect(JSON.parse(open(key))).toEqual({ title: "Anna Rossi is calling", acc: 2 });
    expect(() => open(newDeviceKey())).toThrow();
    expect(sealFor(key, { a: 1 }).iv).not.toBe(sealFor(key, { a: 1 }).iv);
  });
});

describe("service account key file", () => {
  it("is read when present; none leaves FCM off; another file stops the agent", () => {
    const dir = tempDir();
    const file = path.join(dir, "service-account.json");
    expect(loadServiceAccount(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ type: "service_account", ...sa, private_key_id: "k1" }));
    expect(loadServiceAccount(file)).toMatchObject({ project_id: "teamsrelay-test", client_email: sa.client_email });
    fs.writeFileSync(file, JSON.stringify({ project_info: {} }));
    expect(() => loadServiceAccount(file)).toThrow(ConfigError);
  });
});
