import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request, type APIRequestContext, type APIResponse, type Page } from "playwright-core";
import { authorizationCode, bootstrapUrl, configuration, mcasContinuation, mcasForm, mcasMoved, mcasRestore } from "../../../scripts/mcas-auth-forms.mjs";
import { NeedsSignIn, saveCredential, TEAMS_WEB_CLIENT, type MicrosoftSession, type SessionCookie } from "./session-auth";
import type { StoredToken } from "./token";

type Cookie = SessionCookie & { httpOnly?: boolean; secure?: boolean; sameSite?: "Strict" | "Lax" | "None" };
export type McasSessionData = Omit<MicrosoftSession, "cookies"> & { tenantId: string; appOrigin: string; bootstrapUrl: string; cookies: Cookie[] };
type Settings = { authUserData: string; topFrameSaasId: string | number; topFrameSaasIdParamEnabled?: boolean; extendedTopFrameSaasIdParamEnabled?: boolean; resolveNavigationRequestByUrlEnabled?: boolean };

const LOGIN = "https://login.microsoftonline.com";
const PROXY = "https://login.microsoftonline.com.mcas.ms";
const APPS = new Set(["https://teams.microsoft.com", "https://teams.cloud.microsoft"]);
const SCOPE = "openid profile offline_access";
export const mcasSessionFile = (tokenFile: string) => path.join(path.dirname(tokenFile), "mcas-session.json");

function validCookie(c: Cookie): boolean {
  if (!c || ![c.name, c.value, c.domain, c.path].every((s) => typeof s === "string") || !Number.isFinite(c.expires)) return false;
  if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(c.name) || /[\x00-\x20\x7f;]/.test(c.value) || !c.path.startsWith("/")) return false;
  const domain = c.domain.replace(/^\./, "").toLowerCase();
  return domain === "login.microsoftonline.com" || (domain === "mcas.ms" && /^AdallomAuth\d*$/.test(c.name)) || (/^[a-z0-9-]+\.access\.mcas\.ms$/.test(domain) && c.name === "CAACSkipDisclaimer");
}

function bootstrapAddress(value: string): URL {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hostname !== "mcas-proxyweb.mcas.ms" || u.pathname !== "/js-bootstrap.js") throw new NeedsSignIn("MCAS bootstrap destination unsupported");
  return u;
}

function settings(source: string): Settings {
  const c = normal(() => configuration(source, "__JSWRAPPER.initWrapperFixer"));
  // ponytail: only the observed non-integrity context is implemented; a policy change keeps the browser fallback.
  if (c.urlIntegrityEnforcementEnabled !== false || c.suffixDomainName !== "mcas.ms" || c.niptuckSubDomainName !== "mcas-proxyweb") throw new NeedsSignIn("MCAS policy needs browser renewal");
  if (typeof c.authUserData !== "string" || !c.authUserData || c.authUserData.length > 30000 || !["string", "number"].includes(typeof c.topFrameSaasId)) throw new NeedsSignIn("MCAS bootstrap incomplete");
  return c;
}

function normal<T>(parse: () => T): T {
  try { return parse(); } catch { throw new NeedsSignIn("MCAS continuation needs browser renewal"); }
}

function proxyUrl(url: URL, kind: "navigation" | "xhr", c: Settings): URL {
  if (c.extendedTopFrameSaasIdParamEnabled || (kind === "navigation" && c.topFrameSaasIdParamEnabled)) url.searchParams.set("McasTsid", String(c.topFrameSaasId));
  if (kind === "xhr" || c.resolveNavigationRequestByUrlEnabled) url.searchParams.set("McasCtx", kind === "xhr" ? "2" : "4");
  if (kind === "xhr") url.searchParams.set("McasUserAuth", c.authUserData);
  return url;
}

function permitted(value: string, gateway: string): URL {
  const u = new URL(value);
  const allowed = new Set(["login.microsoftonline.com", "login.microsoftonline.com.mcas.ms", "teams.microsoft.com", "teams.microsoft.com.mcas.ms", "teams.cloud.microsoft", "teams.cloud.microsoft.mcas.ms", "inline.cdn.mcas.ms", gateway]);
  if (u.protocol !== "https:" || u.username || u.password || u.port || !allowed.has(u.hostname)) throw new NeedsSignIn("MCAS auth destination unsupported");
  return u;
}

async function text(r: APIResponse, limit = 2 * 1024 * 1024): Promise<string> {
  if (r.status() === 429 || r.status() >= 500) throw new Error(`MCAS HTTP ${r.status()}`);
  if (!r.ok()) throw new NeedsSignIn("MCAS session requires browser renewal");
  const body = await r.text();
  if (Buffer.byteLength(body) > limit) throw new NeedsSignIn("MCAS continuation too large");
  return body;
}

export class McasSession {
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  static load(file: string): McasSessionData | null {
    try {
      const s = JSON.parse(fs.readFileSync(file, "utf8")) as McasSessionData;
      if (typeof s.userAgent !== "string" || !s.userAgent || /[\r\n]/.test(s.userAgent) || typeof s.loginHint !== "string" || !/^[^\s@]+@[^\s@]+$/.test(s.loginHint) || typeof s.tenantId !== "string" || !/^[a-f0-9-]{36}$/i.test(s.tenantId) || !APPS.has(s.appOrigin) || !Array.isArray(s.cookies) || s.cookies.length > 512) return null;
      bootstrapAddress(s.bootstrapUrl);
      return { ...s, cookies: s.cookies.filter(validCookie) };
    } catch { return null; }
  }

  static async capture(file: string, page: Page, identity: { tenantId: string; loginHint: string; userAgent: string }): Promise<boolean> {
    try {
      const here = new URL(page.url());
      const appOrigin = here.origin.replace(/\.mcas\.ms$/, "");
      if (here.protocol !== "https:" || !here.hostname.endsWith(".mcas.ms") || !APPS.has(appOrigin)) return false;
      const context = page.context();
      let root = await context.request.get(`${here.origin}/`, { maxRedirects: 0, timeout: 15000, headers: { "User-Agent": identity.userAgent } });
      for (let i = 0; i < 2 && root.status() >= 300 && root.status() < 400; i++) {
        const next = new URL(root.headers().location, root.url());
        if (next.origin !== here.origin || !["/v2", "/v2/"].includes(next.pathname)) return false;
        root = await context.request.get(next.href, { maxRedirects: 0, timeout: 15000, headers: { "User-Agent": identity.userAgent } });
      }
      const url = bootstrapUrl(await text(root), here.origin);
      if (!url) return false;
      bootstrapAddress(url);
      const result = await context.request.get(url, { maxRedirects: 0, timeout: 10000, headers: { "User-Agent": identity.userAgent, Referer: `${here.origin}/` } });
      settings(await text(result, 128 * 1024));
      const cookies = (await context.cookies()).filter(validCookie);
      const captured: McasSessionData = { ...identity, appOrigin, bootstrapUrl: url, cookies };
      if (!cookies.some((c) => /^ESTSAUTH(?:PERSISTENT|LIGHT)?$/.test(c.name)) || !identity.loginHint) return false;
      saveCredential(file, captured);
      return true;
    } catch { return false; }
  }

  async renew(stored: StoredToken): Promise<StoredToken> {
    const session = McasSession.load(this.file);
    if (!session || session.tenantId !== stored.tenantId || stored.clientId !== TEAMS_WEB_CLIENT) throw new NeedsSignIn("MCAS session missing or unsupported");
    if (!session.cookies.some((c) => /^ESTSAUTH(?:PERSISTENT|LIGHT)?$/.test(c.name) && (c.expires === -1 || c.expires > this.now() / 1000))) throw new NeedsSignIn("Microsoft session ended");
    let client: APIRequestContext;
    try {
      client = await request.newContext({ userAgent: session.userAgent, timeout: 15000, storageState: { cookies: session.cookies.map((c) => ({ ...c, httpOnly: c.httpOnly ?? true, secure: c.secure ?? true, sameSite: c.sameSite ?? "Lax" })), origins: [] } });
    } catch { throw new Error("MCAS request client failed"); }
    const deadline = Date.now() + 90000;
    const send = async (url: string, form?: Record<string, string>, headers?: Record<string, string>) => {
      const timeout = Math.min(15000, deadline - Date.now());
      if (timeout <= 0) throw new Error("MCAS renewal timed out");
      try { return form ? await client.post(url, { form, headers, maxRedirects: 0, timeout }) : await client.get(url, { headers, maxRedirects: 0, timeout }); }
      catch { throw new Error("MCAS request failed"); }
    };
    try {
      const c = settings(await text(await send(session.bootstrapUrl), 128 * 1024));
      const verifier = randomBytes(32).toString("base64url");
      const back = new URL(`${session.appOrigin}/`);
      back.search = new URLSearchParams({ enablemcasfort21: "true", loginHint: session.loginHint, tenantId: stored.tenantId }).toString();
      const state = `${Buffer.from(JSON.stringify({ id: randomUUID(), meta: { interactionType: "redirect" } })).toString("base64")}|${back.href}`;
      const redirect = `${session.appOrigin}/v2/authv2`;
      const url = new URL(`${PROXY}/common/oauth2/v2.0/authorize`);
      url.search = new URLSearchParams({ client_id: stored.clientId, redirect_uri: redirect, response_type: "code", response_mode: "fragment", scope: SCOPE, client_info: "1", login_hint: session.loginHint, state, nonce: randomBytes(24).toString("base64url"), "client-request-id": randomUUID(), code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
      let r = await send(proxyUrl(url, "navigation", c).href);
      let gateway = "", code = "", resumed = false;
      for (let i = 0; i < 14; i++) {
        const from = permitted(r.url(), gateway);
        const location = r.headers().location;
        const next = location ? permitted(new URL(location, from).href, gateway) : null;
        if (next) {
          const p = next.searchParams.has("state") ? next.searchParams : new URLSearchParams(next.hash.slice(1));
          if (p.has("code") || p.has("error")) {
            if (next.origin.replace(/\.mcas\.ms$/, "") !== session.appOrigin || next.pathname !== "/v2/authv2") throw new NeedsSignIn("MCAS callback destination unsupported");
            if (p.get("state") !== state) throw new Error("MCAS callback state mismatch");
            if (["server_error", "temporarily_unavailable"].includes(p.get("error") ?? "")) throw new Error("Microsoft authorize temporarily unavailable");
            if (p.has("error")) throw new NeedsSignIn("Microsoft session requires browser renewal");
            code = normal(() => authorizationCode(next.href, state))!;
            break;
          }
          if (next.hostname === "inline.cdn.mcas.ms") {
            const step = normal(() => mcasRestore(next.href, gateway));
            r = await send(step.action, step.fields, { Origin: next.origin, Referer: `${next.origin}/` });
          } else r = await send(next.href);
          continue;
        }
        const html = await text(r);
        if (from.hostname === gateway && from.pathname === "/finalize_login" && /<title>\s*Object Moved\s*<\/title>/i.test(html)) {
          r = await send(permitted(normal(() => mcasMoved(html)), gateway).href); continue;
        }
        if (html.includes("PROXYWEB_MONITORED_ACCESS_MESSAGE")) {
          const step = normal(() => mcasContinuation(html));
          if (!gateway || new URL(step.action).hostname !== gateway) throw new NeedsSignIn("MCAS gateway changed");
          r = await send(step.action, step.fields, { Origin: from.origin, Referer: `${from.origin}/` }); continue;
        }
        if (/<form\b/i.test(html)) {
          if (from.origin !== LOGIN) throw new NeedsSignIn("MCAS form issuer unsupported");
          const step = normal(() => mcasForm(html)), target = new URL(step.action).hostname;
          if (gateway && gateway !== target) throw new NeedsSignIn("MCAS gateway changed");
          gateway = target;
          r = await send(step.action, { id_token: step.idToken }, { Origin: from.origin, Referer: `${from.origin}/` }); continue;
        }
        let config;
        try { config = configuration(html, "$Config"); } catch { throw new NeedsSignIn("Microsoft session requires browser renewal"); }
        const sessions = Array.isArray(config.arrSessions) ? config.arrSessions.filter((s: { name?: string; matchesLoginHint?: boolean; isSignedIn?: boolean; id?: string } | null) => s && s.isSignedIn === true && s.matchesLoginHint === true && typeof s.name === "string" && s.name.toLowerCase() === session.loginHint.toLowerCase() && typeof s.id === "string" && s.id) : [];
        if (!resumed && String(config.sErrorCode) === "50058" && config.fSsoFeasible === true && sessions.length === 1 && typeof config.urlRefresh === "string") {
          const resume = permitted(new URL(config.urlRefresh, from).href, gateway);
          if (resume.origin !== LOGIN || !/^\/(?:common|[a-f0-9-]{36})\/reprocess$/.test(resume.pathname)) throw new NeedsSignIn("Microsoft session selection unsupported");
          resume.searchParams.set("sessionid", sessions[0].id);
          resumed = true;
          r = await send(resume.href); continue;
        }
        throw new NeedsSignIn("Microsoft session requires browser renewal");
      }
      if (!code) throw new NeedsSignIn("MCAS continuation limit reached");
      const tokenUrl = new URL(`${PROXY}/common/oauth2/v2.0/token`);
      tokenUrl.searchParams.set("client-request-id", randomUUID());
      let target = proxyUrl(tokenUrl, "xhr", c);
      const form = { client_id: stored.clientId, redirect_uri: redirect, grant_type: "authorization_code", code, code_verifier: verifier, scope: SCOPE };
      let origin = `${session.appOrigin}.mcas.ms`;
      for (let i = 0; i < 3; i++) {
        r = await send(target.href, form, { Origin: origin });
        if (r.status() !== 307) break;
        target = permitted(new URL(r.headers().location, target).href, gateway);
        if (target.origin !== LOGIN || target.pathname !== "/common/oauth2/v2.0/token") throw new NeedsSignIn("MCAS token redirect unsupported");
        origin = "null";
      }
      const body = await text(r);
      const result = normal(() => JSON.parse(body)) as { refresh_token?: string; access_token?: string; id_token?: string } | null;
      if (!result || typeof result.refresh_token !== "string" || !result.refresh_token) throw new NeedsSignIn("Microsoft code redemption needs browser renewal");
      for (const token of [result.access_token, result.id_token]) {
        if (typeof token !== "string" || token.split(".").length !== 3) continue;
        const claims = normal(() => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())) as { tid?: unknown };
        if (claims.tid !== undefined && claims.tid !== stored.tenantId) throw new NeedsSignIn("Microsoft returned a different tenant");
      }
      return { ...stored, refreshToken: result.refresh_token, expiresOn: Math.floor(this.now() / 1000) + 86400 };
    } finally {
      try {
        const rotated = await client.storageState();
        saveCredential(this.file, { ...session, cookies: rotated.cookies.filter(validCookie) });
      } finally { await client.dispose(); }
    }
  }
}
