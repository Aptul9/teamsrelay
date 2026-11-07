import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NeedsSignIn, SessionAuth } from "@/agent/light/session-auth";
import { tempDir } from "../helpers";

const stored = { refreshToken: "old", clientId: "client", tenantId: "tenant", region: "emea", expiresOn: 1001 };
const cookie = { name: "ESTSAUTHPERSISTENT", value: "cookie-secret", domain: ".login.microsoftonline.com", path: "/", expires: 90000 };
const setup = () => {
  const file = path.join(tempDir(), "session.json");
  SessionAuth.save(file, { userAgent: "browser-ua", loginHint: "me@example.com", cookies: [cookie] });
  return { file, session: new SessionAuth(file, () => 1000000) };
};

afterEach(() => vi.unstubAllGlobals());

it("uses PKCE, state and the exact redirect without sending cookies to token redemption", async () => {
  const { session } = setup();
  let challenge = "";
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit) => {
    const url = new URL(input);
    expect(init.redirect).toBe("manual");
    if (url.pathname.endsWith("authorize")) {
      const p = url.searchParams;
      expect(p.get("prompt")).toBe("none");
      expect(p.get("login_hint")).toBe("me@example.com");
      expect(p.get("code_challenge_method")).toBe("S256");
      expect(p.get("response_mode")).toBe("query");
      challenge = p.get("code_challenge")!;
      return new Response(null, { status: 302, headers: { Location: `${p.get("redirect_uri")}?code=code-secret&state=${p.get("state")}` } });
    }
    expect(new Headers(init.headers).has("Cookie")).toBe(false);
    expect(new Headers(init.headers).get("Origin")).toBe("https://teams.cloud.microsoft");
    const body = new URLSearchParams(String(init.body));
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(challenge);
    expect(body.get("code")).toBe("code-secret");
    return Response.json({ refresh_token: "new" });
  }));
  expect(await session.renew(stored)).toEqual({ ...stored, refreshToken: "new", expiresOn: 87400 });
});

it("persists rotated cookies on a failed authorize, respecting Max-Age and domain", async () => {
  const { file, session } = setup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503, headers: { "Set-Cookie": "ESTSAUTHPERSISTENT=rolled; Domain=.login.microsoftonline.com; Path=/; Max-Age=7200" } })));
  await expect(session.renew(stored)).rejects.not.toBeInstanceOf(NeedsSignIn);
  expect(SessionAuth.load(file)?.cookies).toEqual([{ ...cookie, value: "rolled", expires: 8200 }]);
});

it.each(["login_required", "interaction_required", "consent_required"])("marks %s as needing owner sign-in, without disclosing the error description", async (error) => {
  const { session } = setup();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = new URL(input);
    return new Response(null, { status: 302, headers: { Location: `https://teams.cloud.microsoft/v2/authv2?state=${url.searchParams.get("state")}&error=${error}&error_description=cookie-secret` } });
  }));
  const result = await session.renew(stored).catch((e: Error) => e);
  expect(result).toBeInstanceOf(NeedsSignIn);
  expect(String(result)).not.toContain("cookie-secret");
});

it("rejects a state mismatch before redeeming a code", async () => {
  const { session } = setup();
  const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://teams.cloud.microsoft/v2/authv2?state=wrong&code=code-secret" } }));
  vi.stubGlobal("fetch", fetch);
  await expect(session.renew(stored)).rejects.toThrow("state mismatch");
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not follow an unexpected redirect or forward cookies to it", async () => {
  const { session } = setup();
  const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://other.test/?code=code-secret" } }));
  vi.stubGlobal("fetch", fetch);
  await expect(session.renew(stored)).rejects.toBeInstanceOf(NeedsSignIn);
  expect(fetch).toHaveBeenCalledOnce();
});

it("treats missing, malformed or expired cookies as needing sign-in, not a network failure", async () => {
  const { file, session } = setup();
  for (const content of ["{}", "broken", JSON.stringify({ userAgent: "ua", loginHint: "", cookies: [{ ...cookie, expires: 999 }] })]) {
    fs.writeFileSync(file, content);
    await expect(session.renew(stored)).rejects.toBeInstanceOf(NeedsSignIn);
  }
});

it("filters other hosts, header injection and cookie paths before sending", async () => {
  const { file, session } = setup();
  SessionAuth.save(file, { userAgent: "ua", loginHint: "", cookies: [cookie, { ...cookie, domain: "evil.login.microsoftonline.com" }, { ...cookie, name: "bad\r\n" }, { ...cookie, path: "/other" }] });
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect(new Headers(init.headers).get("Cookie")).toBe("ESTSAUTHPERSISTENT=cookie-secret");
    return new Response(null, { status: 503 });
  });
  vi.stubGlobal("fetch", fetch);
  await expect(session.renew(stored)).rejects.toThrow("HTTP 503");
});
