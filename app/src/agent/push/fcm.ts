import fs from "node:fs";
import { JWT } from "google-auth-library";
import { z } from "zod";
import { ConfigError } from "../config";

// Firebase Cloud Messaging, HTTP v1 API (https://firebase.google.com/docs/cloud-messaging/send/v1-api), for the phones
// that run the TeamsRelay app of mobile/: one data message per phone, its content sealed with the key of that phone
// (AES-256-GCM, sealFor of seal.ts), so that Google carries ciphertext only, as with Web Push. The app decrypts it and draws the
// notification (mobile/plugin/android). The access token of the service account comes from Google's own client
// (google-auth-library), which signs the JWT and keeps the token until shortly before its end.

const ServiceAccount = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
});
export type ServiceAccount = z.infer<typeof ServiceAccount>;

// The service account key file of the Firebase project; none means FCM off
export function loadServiceAccount(file: string): ServiceAccount | null {
  if (!file || !fs.existsSync(file)) return null;
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`${file}: not JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const r = ServiceAccount.safeParse(json);
  if (!r.success) throw new ConfigError(`${file}: not a service account key file of Google Cloud`);
  return r.data;
}

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

// The outcome of one message: taken, or refused with its HTTP status (0: no answer); gone: the token does not exist any
// more, the phone is to be removed
export type FcmResult = { ok: true } | { ok: false; status: number; gone: boolean; retryAfter?: string };

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class FcmSender {
  private auth: JWT;

  constructor(
    private readonly sa: ServiceAccount,
    private readonly o: { fetch?: Fetch } = {},
  ) {
    this.auth = this.authClient();
  }

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
      // an access token refused before its end: once more with a new client, which asks for a new token
      if (res.status === 401 && attempt === 0) {
        this.auth = this.authClient();
        continue;
      }
      const detail = (await res.json().catch(() => ({}))) as FcmError;
      return { ok: false, status: res.status, gone: tokenGone(res.status, detail), retryAfter: res.headers.get("retry-after") ?? undefined };
    }
  }

  // The OAuth 2.0 client of the service account (JWT bearer grant). Its requests go through the fetch of the sender:
  // gaxios, the HTTP layer of google-auth-library, would otherwise load node-fetch.
  private authClient(): JWT {
    return new JWT({
      email: this.sa.client_email,
      key: this.sa.private_key,
      scopes: [SCOPE],
      transporterOptions: { fetchImplementation: (url, init) => this.fetch(String(url), init as RequestInit), timeout: 15_000 },
    });
  }

  // Kept by the client until five minutes before its end; a refused key throws with Google's reason
  private async accessToken(): Promise<string> {
    const { token } = await this.auth.getAccessToken();
    if (!token) throw new Error("FCM access token refused");
    return token;
  }

  private fetch(url: string, init: RequestInit): Promise<Response> {
    return (this.o.fetch ?? fetch)(url, init);
  }
}

type FcmError = { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } };

// UNREGISTERED (404): the app was removed or its data cleared; INVALID_ARGUMENT about the token (400): never valid;
// SENDER_ID_MISMATCH (403): a token of another Firebase project, which a phone that changed server may have left here
function tokenGone(status: number, d: FcmError): boolean {
  const code = d.error?.details?.find((x) => x.errorCode)?.errorCode ?? d.error?.status;
  return status === 404 || code === "UNREGISTERED" || code === "SENDER_ID_MISMATCH" || (status === 400 && /registration token/i.test(d.error?.message ?? ""));
}
