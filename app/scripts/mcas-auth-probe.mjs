import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LOGIN = "https://login.microsoftonline.com";
const REDIRECT = "https://teams.cloud.microsoft/v2/authv2";
const SCOPE = "https://ic3.teams.office.com/.default openid profile offline_access";
const ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
const decode = (s) => s.replace(/&(?:#x([\da-f]+)|#(\d+)|(amp|quot|apos|lt|gt));/gi, (_, hex, decimal, name) => name ? ENTITIES[name.toLowerCase()] : String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10)));
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/\b([\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map((m) => [m[1].toLowerCase(), decode(m[3])]));
const hiddenInputs = (html) => [...html.matchAll(/<input\b[^>]*>/gi)].map(([tag]) => attributes(tag)).filter((input) => input.type?.toLowerCase() === "hidden");

function gatewayAction(value) {
  const action = new URL(value);
  assert(action.protocol === "https:" && !action.username && !action.password && (!action.port || action.port === "443") && /^[a-z0-9-]+\.access\.mcas\.ms$/i.test(action.hostname) && action.pathname === "/aad_login", "unexpected MCAS form destination");
  return action.href;
}

export function mcasForm(html) {
  const forms = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)];
  assert.equal(forms.length, 1, "one MCAS form required");
  const form = attributes(forms[0][0].slice(0, forms[0][0].indexOf(">") + 1));
  assert.equal(form.method?.toLowerCase(), "post", "MCAS form must use POST");
  const action = gatewayAction(form.action);
  const tokens = hiddenInputs(forms[0][1]).filter((input) => input.name === "id_token");
  assert(tokens.length === 1 && tokens[0].value && tokens[0].value.length < 30000, "one MCAS id_token required");
  return { action, idToken: tokens[0].value };
}

export function mcasContinuation(html) {
  let c;
  try { c = JSON.parse(html.match(/var context\s*=\s*(\{[\s\S]*?\});/)?.[1] ?? ""); } catch { throw new Error("invalid MCAS continuation context"); }
  assert(c.TITLE_ID === "PROXYWEB_MONITORED_ACCESS_MESSAGE" && c.DESCRIPTION_ID === "PROXYWEB_MONITORED_ACCESS_DESCRIPTION" && c.DISPLAY_DISCLAIMER === true && !c.CUSTOMIZED_TITLE && !c.CUSTOMIZED_BODY && !c.WAIT_FOR_APP_ONBOARDING && !c.APP_ONBOARDING_SHOW_CONTINUE && !c.BYPASS_NON_SUFFIX_SUPPORTED_APP_FOR_ADMIN && !c.SECOND_LOGIN_INFORMATION_PAGE_ENABLED, "unsupported MCAS interstitial");
  assert.equal(c.REDIRECT_TO_SUFFIX_METHOD, "POST", "MCAS continuation must use POST");
  const inputs = hiddenInputs(c.ADDITIONAL_HIDDEN_FIELDS ?? "");
  assert(inputs.length > 0 && inputs.every((input) => ["id_token", "appLoginCookies", "contextData"].includes(input.name)), "unsupported MCAS continuation field");
  const fields = Object.fromEntries(inputs.map((input) => [input.name, input.value ?? ""]));
  assert(fields.id_token && new Set(inputs.map((input) => input.name)).size === inputs.length, "one MCAS id_token required");
  return { action: gatewayAction(c.REDIRECT_TO_SUFFIX_URL), fields: { ...fields, continueToSessionControl: "true", isTopFrame: "true", jsNativeBrokerMainWindowDomain: "" } };
}

export function mcasRestore(value, gateway, contextData = "") {
  const url = new URL(value);
  assert(url.protocol === "https:" && !url.username && !url.password && !url.port && url.hostname === "inline.cdn.mcas.ms" && url.pathname === "/proxyweb/1.67.98/html/session-context-restore.html", "unexpected MCAS context-restorer");
  const params = new URLSearchParams(url.hash.slice(1));
  assert(params.get("action") === "post" && params.getAll("action").length === 1 && params.getAll("redirect_uri").length === 1, "unsupported MCAS context-restorer action");
  const target = new URL(params.get("redirect_uri"));
  assert(target.protocol === "https:" && !target.username && !target.password && !target.port && target.hostname === gateway && target.pathname === "/finalize_login", "unexpected MCAS context-restorer target");
  return { action: target.href, fields: { contextData } };
}

export function mcasMoved(html) {
  assert(/<title>\s*Object Moved\s*<\/title>/i.test(html), "unexpected MCAS moved response");
  const matches = [...html.matchAll(/window\.location\.replace\(\s*("(?:\\.|[^"\\])*")\s*\)/g)];
  assert.equal(matches.length, 1, "one literal MCAS redirect required");
  const url = new URL(JSON.parse(matches[0][1]));
  assert(url.protocol === "https:" && !url.username && !url.password && !url.port && ["teams.cloud.microsoft.mcas.ms", "teams.microsoft.com.mcas.ms"].includes(url.hostname) && url.pathname === "/", "unexpected MCAS moved destination");
  return url.href;
}

export function authorizationCode(value, expectedState) {
  const url = new URL(value);
  assert(url.protocol === "https:" && !url.username && !url.password && !url.port && ["teams.cloud.microsoft", "teams.cloud.microsoft.mcas.ms", "teams.microsoft.com.mcas.ms"].includes(url.hostname) && url.pathname === "/v2/authv2", "unexpected authorization callback");
  const params = url.searchParams.has("code") ? url.searchParams : new URLSearchParams(url.hash.slice(1));
  assert(params.get("state") === expectedState, "authorization state mismatch");
  assert(params.get("code"), "authorization code missing");
  return params.get("code");
}

async function main() {
  const dir = fs.realpathSync(process.argv[2]);
  assert(dir.startsWith("/tmp/teamsrelay-compat-"), "an isolated compatibility directory is required");
  const session = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
  const stored = JSON.parse(fs.readFileSync(path.join(dir, "light-token.json"), "utf8"));
  const proxyCookies = process.argv.includes("--reuse-proxy-session") ? JSON.parse(fs.readFileSync(path.join(dir, "proxy-cookies.json"), "utf8")) : [];
  const { request } = createRequire(path.join(process.cwd(), "package.json"))("playwright-core");
  const client = await request.newContext({
    userAgent: session.userAgent, timeout: 20000,
    storageState: { cookies: [...session.cookies, ...proxyCookies].map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly ?? true, secure: c.secure ?? true, sameSite: c.sameSite ?? "Lax" })), origins: [] },
  });
  const send = async (run) => { try { return await run(); } catch { throw new Error("HTTP request failed"); } };
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const endpoint = `${LOGIN}/${encodeURIComponent(stored.tenantId)}/oauth2/v2.0`;
  const authorize = new URL(`${endpoint}/authorize`);
  authorize.search = new URLSearchParams({ client_id: stored.clientId, redirect_uri: REDIRECT, response_type: "code", response_mode: process.argv.includes("--fragment") ? "fragment" : "query", scope: SCOPE, prompt: "none", login_hint: session.loginHint, state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
  if (process.argv.includes("--nonce")) authorize.searchParams.set("nonce", randomBytes(24).toString("base64url"));
  const contextData = process.argv.includes("--with-context") ? JSON.stringify({ context: [{ type: "sessionStorage", name: "cxtrestore_url", value: authorize.href }, { type: "sessionStorage", name: "cxtrestore_time", value: String(Date.now()) }] }) : "";
  let gateway = "";
  let code = "";
  try {
    let response = await send(() => client.get(authorize.href, { maxRedirects: 0 }));
    for (let hop = 0; hop < 6; hop++) {
      const from = new URL(response.url());
      const location = response.headers().location;
      const next = location ? new URL(location, from) : null;
      if (next) fs.writeFileSync(path.join(dir, "last-continuation.json"), JSON.stringify({ next: next.href }), { mode: 0o600 });
      const fragment = next ? new URLSearchParams(next.hash.slice(1)) : null;
      let restore;
      try { const u = new URL(fragment?.get("redirect_uri")); restore = { host: u.hostname, path: u.pathname, queryKeys: [...u.searchParams.keys()] }; } catch {}
      console.log(JSON.stringify({ hop, status: response.status(), host: from.hostname, path: from.pathname, nextHost: next?.hostname, nextPath: next?.pathname, nextQueryKeys: next ? [...next.searchParams.keys()] : [], fragmentAction: ["post", "store"].includes(fragment?.get("action")) ? fragment.get("action") : undefined, restore, cookieNames: response.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value.split("=", 1)[0]) }));
      if (next && (next.searchParams.has("code") || new URLSearchParams(next.hash.slice(1)).has("code"))) {
        code = authorizationCode(next.href, state);
        break;
      }
      if (next) {
        if (next.hostname === "inline.cdn.mcas.ms") {
          const restore = mcasRestore(next.href, gateway, contextData);
          response = await send(() => client.post(restore.action, { form: restore.fields, headers: { Origin: next.origin, Referer: `${next.origin}/` }, maxRedirects: 0 }));
          continue;
        }
        assert(next.protocol === "https:" && !next.username && !next.password && (!next.port || next.port === "443") && ["login.microsoftonline.com", "teams.cloud.microsoft", "teams.cloud.microsoft.mcas.ms", "teams.microsoft.com.mcas.ms", gateway].includes(next.hostname), "unexpected continuation host");
        response = await send(() => client.get(next.href, { maxRedirects: 0 }));
        continue;
      }
      const html = await response.text();
      if (response.status() !== 200) {
        fs.writeFileSync(path.join(dir, "mcas-error.html"), html, { mode: 0o600 });
        const visible = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").replace(/[A-Za-z0-9_\-+=/.]{40,}/g, "<opaque>").slice(0, 2000);
        console.log(JSON.stringify({ failureStatus: response.status(), htmlTitle: html.match(/<title>([^<]{0,100})<\/title>/i)?.[1], visibleError: visible }));
        throw new Error("authentication continuation was not successful");
      }
      if (from.hostname === gateway && from.pathname === "/finalize_login" && /<title>\s*Object Moved\s*<\/title>/i.test(html)) {
        const moved = mcasMoved(html);
        assert.equal(new URL(moved).searchParams.get("tenantId"), stored.tenantId, "MCAS moved to another tenant");
        response = await send(() => client.get(moved, { maxRedirects: 0 }));
        continue;
      }
      if (gateway && /var context\s*=/.test(html)) {
        const continuation = mcasContinuation(html);
        assert.equal(new URL(continuation.action).hostname, gateway, "MCAS gateway changed");
        response = await send(() => client.post(continuation.action, { form: continuation.fields, headers: { Origin: from.origin, Referer: `${from.origin}/` }, maxRedirects: 0 }));
        continue;
      }
      if (!/<form\b/i.test(html)) {
        fs.writeFileSync(path.join(dir, "mcas-continuation.html"), html, { mode: 0o600 });
        const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => ({ bytes: m[1].length, literalLocationReplace: /window\.location\.replace/.test(m[1]), usesSessionStorage: /sessionStorage/.test(m[1]) }));
        console.log(JSON.stringify({ htmlTitle: html.match(/<title>([^<]{0,100})<\/title>/i)?.[1], contentType: response.headers()["content-type"], inlineScripts: scripts, requiresUnimplementedContinuation: true }));
        throw new Error("authentication needs another continuation");
      }
      const form = mcasForm(html);
      const target = new URL(form.action).hostname;
      assert(gateway ? target === gateway : from.origin === LOGIN, "MCAS gateway changed or has an unexpected issuer");
      gateway = target;
      response = await send(() => client.post(form.action, { form: { id_token: form.idToken }, headers: { Origin: from.origin, Referer: `${from.origin}/` }, maxRedirects: 0 }));
    }
    assert(code, "no authorization code returned within six continuations");
    const token = await fetch(`${endpoint}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: new URL(REDIRECT).origin, "User-Agent": session.userAgent }, body: new URLSearchParams({ client_id: stored.clientId, grant_type: "authorization_code", redirect_uri: REDIRECT, scope: SCOPE, code, code_verifier: verifier }), redirect: "manual", signal: AbortSignal.timeout(20000) }).catch(() => { throw new Error("code redemption request failed"); });
    const j = await token.json();
    console.log(JSON.stringify({ tokenHttp: token.status, refreshTokenPresent: !!j.refresh_token, error: /^[a-z_]+$/.test(j.error ?? "") ? j.error : undefined }));
    assert(token.ok && j.refresh_token, "code did not redeem a refresh token");
    fs.writeFileSync(path.join(dir, "fresh-token.json"), JSON.stringify({ ...stored, refreshToken: j.refresh_token, expiresOn: Math.floor(Date.now() / 1000) + 86400 }), { mode: 0o600 });
    await client.storageState({ path: path.join(dir, "http-session-state.json") });
    fs.chmodSync(path.join(dir, "http-session-state.json"), 0o600);
    console.log(JSON.stringify({ completedWithoutBrowser: true }));
  } finally {
    await client.storageState({ path: path.join(dir, "http-session-state.json") });
    fs.chmodSync(path.join(dir, "http-session-state.json"), 0o600);
    await client.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error(e.message.split("\n")[0]); process.exitCode = 1; });
