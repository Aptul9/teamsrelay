import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { request, type APIRequestContext, type Page } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";
import { McasSession, type McasSessionData } from "@/agent/light/mcas-session";
import { NeedsSignIn, TEAMS_WEB_CLIENT } from "@/agent/light/session-auth";
import { tempDir } from "../helpers";

vi.mock("playwright-core", () => ({ request: { newContext: vi.fn() } }));
afterEach(() => vi.clearAllMocks());

const tenant = "11111111-2222-3333-4444-555555555555";
const gateway = "tenant.access.mcas.ms";
const bootstrap = "https://mcas-proxyweb.mcas.ms/js-bootstrap.js?McasTsid=42&type=window";
const cookie = { name: "ESTSAUTHPERSISTENT", value: "private-cookie", domain: ".login.microsoftonline.com", path: "/", expires: 90000 };
const proxyCookie = { ...cookie, name: "AdallomAuth00", domain: ".mcas.ms" };
const settings = {
  suffixDomainName: "mcas.ms", niptuckSubDomainName: "mcas-proxyweb", tenantId: "a-different-mcas-internal-tenant",
  authUserData: "private-proxy-auth", topFrameSaasId: 42, topFrameSaasIdParamEnabled: true,
  extendedTopFrameSaasIdParamEnabled: true, resolveNavigationRequestByUrlEnabled: true, urlIntegrityEnforcementEnabled: false,
};
const stored = { refreshToken: "old-rt", clientId: TEAMS_WEB_CLIENT, tenantId: tenant, region: "emea", expiresOn: 2000 };
const response = (url: string, body: string | object = "", status = 200, headers: Record<string, string> = {}) => ({
  url: () => url, status: () => status, ok: () => status >= 200 && status < 300, headers: () => headers,
  text: async () => typeof body === "string" ? body : JSON.stringify(body), json: async () => typeof body === "string" ? JSON.parse(body) : body,
});

function setup(options: { wrongState?: boolean; integrity?: boolean; sessions?: object[]; transient?: boolean; redirect?: string; malformedBootstrap?: boolean; credentialForm?: boolean; wrongTenant?: boolean; plainCallback?: boolean; callbackError?: string } = {}) {
  const file = path.join(tempDir(), "mcas-session.json");
  const data: McasSessionData = { userAgent: "browser-ua", loginHint: "me@example.com", tenantId: tenant, appOrigin: "https://teams.microsoft.com", bootstrapUrl: bootstrap, cookies: [cookie, proxyCookie] };
  fs.writeFileSync(file, JSON.stringify(data));
  let state = "", challenge = "";
  const get = vi.fn(async (value: string) => {
    const u = new URL(value);
    if (u.href === bootstrap) return response(value, options.malformedBootstrap ? "unrecognized-bootstrap" : `__JSWRAPPER.initWrapperFixer(${JSON.stringify({ ...settings, urlIntegrityEnforcementEnabled: !!options.integrity })});`, options.transient ? 503 : 200);
    if (u.hostname === "login.microsoftonline.com.mcas.ms") {
      state = u.searchParams.get("state")!; challenge = u.searchParams.get("code_challenge")!;
      expect(u.searchParams.get("McasCtx")).toBe("4");
      expect(u.searchParams.get("McasTsid")).toBe("42");
      expect(u.searchParams.get("redirect_uri")).toBe("https://teams.microsoft.com/v2/authv2");
      return response(value, "", 302, { location: options.redirect ?? "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?cas=private" });
    }
    if (u.pathname.endsWith("/authorize")) return response(value, `<script>$Config=${JSON.stringify({ sErrorCode: "50058", fSsoFeasible: true, sPOST_Username: "me@example.com", arrSessions: options.sessions ?? [{ id: "owned-session", name: "me@example.com", matchesLoginHint: true, isSignedIn: true }], urlRefresh: "https://login.microsoftonline.com/common/reprocess?ctx=private" })};</script>`);
    if (u.pathname === "/common/reprocess") {
      expect(u.searchParams.get("sessionid")).toBe("owned-session");
      if (options.credentialForm) return response(value, '<form method="post" action="https://login.microsoftonline.com/common/login"><input type="password" name="passwd"></form>');
      return response(value, `<form method="post" action="https://${gateway}/aad_login"><input type="hidden" name="id_token" value="private-token"></form>`);
    }
    throw new Error("unexpected test GET");
  });
  const post = vi.fn(async (value: string, init: { form: Record<string, string>; headers?: Record<string, string> }) => {
    const u = new URL(value);
    if (u.hostname === gateway) return response(value, "", 302, { location: `https://teams.microsoft.com${options.plainCallback ? "" : ".mcas.ms"}/v2/authv2#${options.callbackError ? `error=${options.callbackError}` : "code=private-code"}&state=${encodeURIComponent(options.wrongState ? "wrong" : state)}` });
    expect(init.form.client_id).toBe(TEAMS_WEB_CLIENT);
    expect(init.form.grant_type).toBe("authorization_code");
    expect(init.form.code).toBe("private-code");
    expect(createHash("sha256").update(init.form.code_verifier).digest("base64url")).toBe(challenge);
    if (u.hostname === "login.microsoftonline.com.mcas.ms") {
      expect(u.searchParams.get("McasCtx")).toBe("2");
      expect(u.searchParams.get("McasUserAuth")).toBe("private-proxy-auth");
      expect(init.headers?.Origin).toBe("https://teams.microsoft.com.mcas.ms");
      return response(value, "", 307, { location: "https://login.microsoftonline.com/common/oauth2/v2.0/token" });
    }
    expect(u.hostname).toBe("login.microsoftonline.com");
    expect(init.headers?.Origin).toBe("null");
    return response(value, { refresh_token: "new-rt", access_token: options.wrongTenant ? `header.${Buffer.from(JSON.stringify({ tid: "other-tenant" })).toString("base64url")}.signature` : "new-access" });
  });
  const dispose = vi.fn(async () => undefined);
  const context = { get, post, storageState: async () => ({ cookies: [{ ...cookie, value: "rolled-cookie" }, proxyCookie], origins: [] }), dispose };
  vi.mocked(request.newContext).mockResolvedValue(context as unknown as APIRequestContext);
  return { file, data, get, post, dispose, session: new McasSession(file, () => 1000000) };
}

it("renews through the normal MCAS/SSO account selection and proxy token redirect, with fresh state and PKCE", async () => {
  const { session, file, dispose } = setup();
  expect(await session.renew(stored)).toEqual({ ...stored, refreshToken: "new-rt", expiresOn: 87400 });
  expect(McasSession.load(file)?.cookies[0].value).toBe("rolled-cookie");
  expect(dispose).toHaveBeenCalledOnce();
});

it.each([
  [{ id: "other", name: "other@example.com", matchesLoginHint: true, isSignedIn: true }],
  [{ id: "owned-session", name: "me@example.com", matchesLoginHint: true, isSignedIn: false }],
  [{ id: "one", name: "me@example.com", matchesLoginHint: true, isSignedIn: true }, { id: "two", name: "me@example.com", matchesLoginHint: true, isSignedIn: true }],
])("does not select an absent, signed-out or ambiguous account", async (...sessions) => {
  const { session, post } = setup({ sessions });
  await expect(session.renew(stored)).rejects.toBeInstanceOf(NeedsSignIn);
  expect(post).not.toHaveBeenCalled();
});

it("rejects a wrong callback state before token redemption", async () => {
  const { session, post } = setup({ wrongState: true });
  await expect(session.renew(stored)).rejects.toThrow(/state/i);
  expect(post.mock.calls.every(([url]) => !url.includes("/token"))).toBe(true);
});

it("uses browser fallback for a callback variant outside the observed parser contract", async () => {
  const { session, post } = setup({ plainCallback: true });
  await expect(session.renew(stored)).rejects.toBeInstanceOf(NeedsSignIn);
  expect(post.mock.calls.every(([url]) => !url.includes("/token"))).toBe(true);
});

it.each(["server_error", "temporarily_unavailable"])("retries OAuth %s without switching to browser renewal", async (callbackError) => {
  const { session, post } = setup({ callbackError });
  await expect(session.renew(stored)).rejects.not.toBeInstanceOf(NeedsSignIn);
  expect(post.mock.calls.every(([url]) => !url.includes("/token"))).toBe(true);
});

it("falls back without weakening an unimplemented integrity policy", async () => {
  const { session, get, post } = setup({ integrity: true });
  await expect(session.renew(stored)).rejects.toBeInstanceOf(NeedsSignIn);
  expect(get).toHaveBeenCalledOnce();
  expect(post).not.toHaveBeenCalled();
});

it("never follows an unrelated redirect", async () => {
  const { session, get, post } = setup({ redirect: "https://unrelated.test/path?code=private" });
  await expect(session.renew(stored)).rejects.toBeInstanceOf(NeedsSignIn);
  expect(get.mock.calls.every(([url]) => !url.includes("unrelated.test"))).toBe(true);
  expect(post).not.toHaveBeenCalled();
});

it("persists rotated cookies on a transient error without declaring owner sign-in required", async () => {
  const { session, file, dispose } = setup({ transient: true });
  await expect(session.renew(stored)).rejects.not.toBeInstanceOf(NeedsSignIn);
  expect(McasSession.load(file)?.cookies[0].value).toBe("rolled-cookie");
  expect(dispose).toHaveBeenCalledOnce();
});

it.each([{ malformedBootstrap: true }, { credentialForm: true }, { wrongTenant: true }])("uses browser fallback for unsupported auth responses or a different Entra tenant", async (options) => {
  const { session } = setup(options);
  await expect(session.renew(stored)).rejects.toBeInstanceOf(NeedsSignIn);
});

it("captures the observed bootstrap from raw Teams HTML, not a saved HAR or a browser launch", async () => {
  const { file, data } = setup();
  fs.unlinkSync(file);
  const get = vi.fn(async (url: string) => url === bootstrap
    ? response(url, `__JSWRAPPER.initWrapperFixer(${JSON.stringify(settings)});`)
    : response(url, `<script src="${bootstrap.replaceAll("&", "&amp;")}"></script>`));
  const page = { url: () => "https://teams.microsoft.com.mcas.ms/", context: () => ({ request: { get }, cookies: async () => data.cookies }) } as unknown as Page;
  expect(await McasSession.capture(file, page, { tenantId: tenant, loginHint: data.loginHint, userAgent: data.userAgent })).toBe(true);
  expect(McasSession.load(file)).toMatchObject({ appOrigin: data.appOrigin, bootstrapUrl: bootstrap, tenantId: tenant });
  expect(get).toHaveBeenCalledTimes(2);
});

it("follows only the observed same-origin legacy root redirect to v2 during capture", async () => {
  const { file, data } = setup(); fs.unlinkSync(file);
  const origin = "https://teams.microsoft.com.mcas.ms";
  const get = vi.fn(async (url: string) => url === origin + "/"
    ? response(url, "", 302, { location: "/v2" })
    : url === bootstrap ? response(url, `__JSWRAPPER.initWrapperFixer(${JSON.stringify(settings)});`)
      : response(url, `<script src="${bootstrap}"></script>`));
  const page = { url: () => origin + "/v2/", context: () => ({ request: { get }, cookies: async () => data.cookies }) } as unknown as Page;
  expect(await McasSession.capture(file, page, { tenantId: tenant, loginHint: data.loginHint, userAgent: data.userAgent })).toBe(true);
  expect(get.mock.calls.map(([url]) => url)).toEqual([origin + "/", origin + "/v2", bootstrap]);
});

it("does not follow a cross-origin redirect while capturing bootstrap metadata", async () => {
  const { file, data } = setup(); fs.unlinkSync(file);
  const get = vi.fn(async (url: string) => response(url, "", 302, { location: "https://unrelated.test/v2" }));
  const page = { url: () => "https://teams.microsoft.com.mcas.ms/", context: () => ({ request: { get }, cookies: async () => data.cookies }) } as unknown as Page;
  expect(await McasSession.capture(file, page, { tenantId: tenant, loginHint: data.loginHint, userAgent: data.userAgent })).toBe(false);
  expect(get).toHaveBeenCalledOnce();
});
