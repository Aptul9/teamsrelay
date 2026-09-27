import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import { ConfigError } from "../config";

// Firebase Cloud Messaging, HTTP v1 API (https://firebase.google.com/docs/cloud-messaging/send/v1-api), for the phones
// that run the TeamsRelay app of mobile/: one data message per phone, its content sealed with the key of that phone
// (AES-256-GCM, sealFor), so that Google carries ciphertext only, as with Web Push. The app decrypts it and draws the
// notification (mobile/plugin/android).

const ServiceAccount = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  token_uri: z.string().url().default("https://oauth2.googleapis.com/token"),
});
export type ServiceAccount = z.infer<typeof ServiceAccount>;

// The service account key file of the Firebase project; none means FCM off
export function loadServiceAccount(file: string): ServiceAccount | null {
  if (!file || !fs.existsSync(file)) return null;
  const r = ServiceAccount.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!r.success) throw new ConfigError(`${file}: not a service account key file of Google Cloud`);
  return r.data;
}

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

// The outcome of one message: taken, or refused with its HTTP status (0: no answer); gone: the token does not exist any
// more, the phone is to be removed
export type FcmResult = { ok: true } | { ok: false; status: number; gone: boolean; retryAfter?: string };

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class FcmSender {
  private access: { token: string; until: number } | null = null;

  constructor(
    private readonly sa: ServiceAccount,
    private readonly o: { fetch?: Fetch; clock?: () => number } = {},
  ) {}

  // A data message to one phone: priority high wakes a phone in Doze at once; ttl, seconds the service keeps it
  async send(token: string, data: Record<string, string>, opts: { ttl: number; high: boolean }): Promise<FcmResult> {
    const body = JSON.stringify({ message: { token, data, android: { priority: opts.high ? "HIGH" : "NORMAL", ttl: `${opts.ttl}s` } } });
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(`https://fcm.googleapis.com/v1/projects/${this.sa.project_id}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return { ok: true };
      // an access token refused before its end: once more with a new one
      if (res.status === 401 && attempt === 0) {
        this.access = null;
        continue;
      }
      const detail = (await res.json().catch(() => ({}))) as FcmError;
      return { ok: false, status: res.status, gone: tokenGone(res.status, detail), retryAfter: res.headers.get("retry-after") ?? undefined };
    }
  }

  // OAuth 2.0 access token of the service account (JWT bearer grant), kept until five minutes before its end
  private async accessToken(): Promise<string> {
    const now = (this.o.clock ?? Date.now)();
    if (this.access && now < this.access.until) return this.access.token;
    const iat = Math.floor(now / 1000);
    const part = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: this.sa.client_email, scope: SCOPE, aud: this.sa.token_uri, iat, exp: iat + 3600 })}`;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), this.sa.private_key).toString("base64url");
    const res = await this.fetch(this.sa.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`FCM access token refused: HTTP ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.access = { token: j.access_token, until: now + (j.expires_in - 300) * 1000 };
    return j.access_token;
  }

  private fetch(url: string, init: RequestInit): Promise<Response> {
    return (this.o.fetch ?? fetch)(url, init);
  }
}

type FcmError = { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } };

// UNREGISTERED (404): the app was removed or its data cleared; INVALID_ARGUMENT about the token (400): never valid
function tokenGone(status: number, d: FcmError): boolean {
  const code = d.error?.details?.find((x) => x.errorCode)?.errorCode ?? d.error?.status;
  return status === 404 || code === "UNREGISTERED" || (status === 400 && /registration token/i.test(d.error?.message ?? ""));
}

// The key of a phone: 32 random bytes, base64url, handed to the app once at registration
export const newDeviceKey = () => crypto.randomBytes(32).toString("base64url");

// The data of the FCM message for `content`: v 1, iv (12 random bytes), ct (ciphertext and 16-byte tag), base64url
export function sealFor(key: string, content: object): Record<string, string> {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(content), "utf8"), c.final(), c.getAuthTag()]);
  return { v: "1", iv: iv.toString("base64url"), ct: ct.toString("base64url") };
}
