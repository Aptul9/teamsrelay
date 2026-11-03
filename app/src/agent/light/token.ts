import fs from "node:fs";

// Access tokens of a light account (no browser of its own): redeemed in Node from the MSAL refresh token the
// account's browser run captured (jobs/light-token.ts), as Teams web redeems it (single-page app, so with its Origin).
// Microsoft rolls the refresh token at each renewal, the expiry stays: a refresh token of a single-page app holds 24 h
// from the browser's sign-in, its rolls included.

export const IC3 = "https://ic3.teams.office.com/.default";
export const CHATSVCAGG = "https://chatsvcagg.teams.microsoft.com/.default";
export const SPACES = "https://api.spaces.skype.com/.default";
export const PRESENCE = "https://presence.teams.microsoft.com/.default";

// region: of the chat service, as the cookies of the browser said it; expiresOn: Unix seconds the refresh token ends
export type StoredToken = { refreshToken: string; clientId: string; tenantId: string; region: string; expiresOn: number };

// No refresh token, or Microsoft refused it: the account needs its browser run (or a sign-in there)
export class SignedOut extends Error {}

// a token renewed this long before it expires
const MARGIN_MS = 5 * 60_000;

export class LightToken {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  // a credential: readable by its owner only
  static save(file: string, stored: StoredToken) {
    fs.writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }

  static load(file: string): StoredToken | null {
    try {
      const s = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoredToken>;
      if (typeof s.refreshToken !== "string" || !s.refreshToken || typeof s.clientId !== "string" || typeof s.tenantId !== "string") return null;
      return { refreshToken: s.refreshToken, clientId: s.clientId, tenantId: s.tenantId, region: s.region || "emea", expiresOn: Number(s.expiresOn) || 0 };
    } catch {
      return null;
    }
  }

  stored(): StoredToken | null {
    return LightToken.load(this.file);
  }

  // The next access tokens are redeemed again: right before the refresh token ends, so the last ones it gives outlive
  // it by their own hour
  renewAll() {
    this.cache.clear();
  }

  async accessToken(scope: string): Promise<string> {
    const hit = this.cache.get(scope);
    if (hit && this.now() < hit.expiresAt - MARGIN_MS) return hit.token;
    const stored = this.stored();
    if (!stored) throw new SignedOut("no refresh token stored");
    const r = await fetch(`https://login.microsoftonline.com/${stored.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://teams.microsoft.com" },
      body: new URLSearchParams({
        client_id: stored.clientId,
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
        scope: `${scope} openid profile offline_access`,
        client_info: "1",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!r.ok || !j.access_token) {
      // a token still cached keeps working until it ends
      if (hit && this.now() < hit.expiresAt) return hit.token;
      if (j.error === "invalid_grant") throw new SignedOut("refresh token refused");
      throw new Error(`token endpoint ${r.status} ${j.error ?? ""}`.trim());
    }
    if (j.refresh_token) LightToken.save(this.file, { ...stored, refreshToken: j.refresh_token });
    this.cache.set(scope, { token: j.access_token, expiresAt: this.now() + (j.expires_in ?? 3600) * 1000 });
    return j.access_token;
  }
}
