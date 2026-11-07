import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StoredToken } from "./token";

export const TEAMS_WEB_CLIENT = "5e3ce6c0-2b1f-4285-8d4b-75ee78787346";
const LOGIN = "https://login.microsoftonline.com";
const REDIRECT = "https://teams.cloud.microsoft/v2/authv2";
const SCOPE = "https://ic3.teams.office.com/.default openid profile offline_access";

export type SessionCookie = { name: string; value: string; domain: string; path: string; expires: number };
export type MicrosoftSession = { userAgent: string; loginHint: string; cookies: SessionCookie[] };
export class NeedsSignIn extends Error {}

export const sessionFile = (tokenFile: string) => path.join(path.dirname(tokenFile), "session.json");

const loginCookie = (c: SessionCookie) =>
  /^\.?login\.microsoftonline\.com$/i.test(c.domain) && /^[!#$%&'*+.^_`|~\w-]+$/.test(c.name) && !/[\x00-\x20\x7f;]/.test(c.value) && c.path.startsWith("/");

export function saveCredential(file: string, value: unknown) {
  fs.writeFileSync(`${file}.new`, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(`${file}.new`, 0o600);
  fs.renameSync(`${file}.new`, file);
}

export class SessionAuth {
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  static save(file: string, session: MicrosoftSession) {
    saveCredential(file, { ...session, cookies: session.cookies.filter(loginCookie) });
  }

  static load(file: string): MicrosoftSession | null {
    try {
      const s = JSON.parse(fs.readFileSync(file, "utf8")) as MicrosoftSession;
      if (!s.userAgent || typeof s.userAgent !== "string" || /[\r\n]/.test(s.userAgent) || typeof s.loginHint !== "string" || !Array.isArray(s.cookies)) return null;
      const cookies = s.cookies.filter((c) => c && [c.name, c.value, c.domain, c.path].every((v) => typeof v === "string") && Number.isFinite(c.expires) && loginCookie(c));
      return { userAgent: s.userAgent, loginHint: s.loginHint, cookies };
    } catch {
      return null;
    }
  }

  private rotate(s: MicrosoftSession, r: Response) {
    for (const raw of r.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const equals = pair.indexOf("=");
      if (equals < 1) continue;
      const c: SessionCookie = { name: pair.slice(0, equals).trim(), value: pair.slice(equals + 1).trim(), domain: "login.microsoftonline.com", path: "/", expires: -1 };
      let maxAge: number | undefined;
      for (const attr of attrs) {
        const at = attr.indexOf("=");
        const key = (at < 0 ? attr : attr.slice(0, at)).trim().toLowerCase();
        const value = at < 0 ? "" : attr.slice(at + 1).trim();
        if (key === "domain") c.domain = value;
        else if (key === "path") c.path = value;
        else if (key === "expires" && Number.isFinite(Date.parse(value))) c.expires = Date.parse(value) / 1000;
        else if (key === "max-age" && /^-?\d+$/.test(value)) maxAge = Number(value);
      }
      if (maxAge !== undefined) c.expires = this.now() / 1000 + maxAge;
      if (!loginCookie(c)) continue;
      s.cookies = s.cookies.filter((old) => !(old.name === c.name && old.domain.replace(/^\./, "").toLowerCase() === c.domain.replace(/^\./, "").toLowerCase() && old.path === c.path));
      if (c.expires === -1 || c.expires > this.now() / 1000) s.cookies.push(c);
    }
    SessionAuth.save(this.file, s);
  }

  private async request(url: URL | string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Error("Microsoft session request failed");
    }
  }

  async renew(stored: StoredToken): Promise<StoredToken> {
    const s = SessionAuth.load(this.file);
    if (!s) throw new NeedsSignIn("Microsoft session missing or unreadable");
    const endpoint = `${LOGIN}/${encodeURIComponent(stored.tenantId)}/oauth2/v2.0`;
    const url = new URL(`${endpoint}/authorize`);
    const cookies = s.cookies.filter((c) => (c.expires === -1 || c.expires > this.now() / 1000) && (c.path === "/" || url.pathname === c.path || url.pathname.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`)));
    if (!cookies.some((c) => /^ESTSAUTH(?:PERSISTENT|LIGHT)?$/i.test(c.name))) throw new NeedsSignIn("Microsoft session ended");
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    url.search = new URLSearchParams({
      client_id: stored.clientId, redirect_uri: REDIRECT, response_type: "code", response_mode: "query",
      scope: SCOPE, prompt: "none", login_hint: s.loginHint, state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    }).toString();
    const r = await this.request(url, { headers: { Cookie: cookies.sort((a, b) => b.path.length - a.path.length).map((c) => `${c.name}=${c.value}`).join("; "), "User-Agent": s.userAgent } });
    this.rotate(s, r);
    if (r.status === 429 || r.status >= 500) throw new Error(`Microsoft authorize HTTP ${r.status}`);
    const location = r.headers.get("Location");
    if (r.status < 300 || r.status >= 400 || !location) throw new NeedsSignIn("Microsoft session requires sign-in");
    const back = new URL(location, LOGIN);
    if (back.origin + back.pathname !== REDIRECT || back.username || back.password) throw new NeedsSignIn("Microsoft session requires interactive sign-in");
    if (back.searchParams.get("state") !== state) throw new Error("Microsoft authorize state mismatch");
    const error = back.searchParams.get("error");
    if (error === "server_error" || error === "temporarily_unavailable") throw new Error("Microsoft authorize temporarily unavailable");
    if (error) throw new NeedsSignIn("Microsoft session requires sign-in");
    const code = back.searchParams.get("code");
    if (!code) throw new NeedsSignIn("Microsoft authorize returned no code");
    const token = await this.request(`${endpoint}/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: new URL(REDIRECT).origin, "User-Agent": s.userAgent },
      body: new URLSearchParams({ client_id: stored.clientId, redirect_uri: REDIRECT, grant_type: "authorization_code", code, code_verifier: verifier, scope: SCOPE }),
    });
    this.rotate(s, token);
    const j = await token.json().catch(() => ({})) as { refresh_token?: string; error?: string };
    if (token.status === 429 || token.status >= 500) throw new Error(`Microsoft code redeem HTTP ${token.status}`);
    if (!token.ok || !j.refresh_token) throw new NeedsSignIn("Microsoft code redeem requires sign-in");
    return { ...stored, refreshToken: j.refresh_token, expiresOn: Math.floor(this.now() / 1000) + 86400 };
  }
}
