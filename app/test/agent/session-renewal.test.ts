import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Light } from "@/agent/light/context";
import { renewSignIn } from "@/agent/light/loop";
import { LightToken } from "@/agent/light/token";
import { SessionAuth } from "@/agent/light/session-auth";
import { McasSession } from "@/agent/light/mcas-session";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(1000000));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup(expiresOn = 2000, refused = false) {
  const dir = tempDir();
  const file = path.join(dir, "light-token.json");
  LightToken.save(file, { refreshToken: "old", clientId: "client", tenantId: "tenant", region: "emea", expiresOn });
  SessionAuth.save(path.join(dir, "session.json"), { userAgent: "ua", loginHint: "me@example.com", cookies: [{ name: "ESTSAUTHPERSISTENT", value: "cookie", domain: ".login.microsoftonline.com", path: "/", expires: 100000 }] });
  const state = new Map<string, string>([[STATE.lightToken, JSON.stringify({ at: 1, expiresOn, refused, session: true })]]);
  const token = new LightToken(file);
  const clear = vi.spyOn(token, "renewAll");
  const l = { config: { lightTokenFile: file }, token, signedOut: refused, store: { getState: (k: string) => state.get(k) ?? "", setState: (k: string, v: string) => { state.set(k, v); } } } as unknown as Light;
  return { dir, file, l, clear, state, renewed: { for: 0, retryAt: 0 } };
}

const granted = () => vi.fn(async (input: string | URL) => {
  const url = new URL(input);
  return url.pathname.endsWith("authorize")
    ? new Response(null, { status: 302, headers: { Location: `https://teams.cloud.microsoft/v2/authv2?code=c&state=${url.searchParams.get("state")}` } })
    : Response.json({ refresh_token: "new" });
});

it("renews the stored SPA token in the job, leaving ordinary scope redemption separate", async () => {
  const { file, l, clear, state, renewed } = setup();
  const fetch = granted();
  vi.stubGlobal("fetch", fetch);
  await renewSignIn(l, renewed);
  expect(LightToken.load(file)).toMatchObject({ refreshToken: "new", expiresOn: 87400 });
  expect(JSON.parse(state.get(STATE.lightToken)!)).toMatchObject({ session: true, expiresOn: 87400, refused: false });
  expect(clear).toHaveBeenCalledOnce();
  await renewSignIn(l, renewed);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("replays authorize when the scope redemption marked a still-young token refused", async () => {
  const { l, renewed } = setup(80000, true);
  const fetch = granted();
  vi.stubGlobal("fetch", fetch);
  await renewSignIn(l, renewed);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(l.signedOut).toBe(false);
});

it("backs off transient failures without clearing access tokens or marking sign-in refused", async () => {
  const { l, clear, state, renewed } = setup();
  const fetch = vi.fn(async () => new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  await renewSignIn(l, renewed);
  await renewSignIn(l, renewed);
  expect(fetch).toHaveBeenCalledOnce();
  expect(clear).not.toHaveBeenCalled();
  expect(JSON.parse(state.get(STATE.lightToken)!)).toMatchObject({ refused: false });
});

it("requests browser fallback for a missing session without declaring a still-usable token signed out", async () => {
  const { dir, l, state, renewed } = setup();
  fs.unlinkSync(path.join(dir, "session.json"));
  await renewSignIn(l, renewed);
  expect(JSON.parse(state.get(STATE.lightToken)!)).toMatchObject({ refused: false, session: true, browser: true });
  expect(l.signedOut).toBe(false);
});

it("hands an MCAS form to browser renewal once, keeping the current token", async () => {
  const { l, state, renewed, file } = setup();
  const fetch = vi.fn(async () => new Response('<form method="post" action="https://tenant.access.mcas.ms/aad_login"><input name="id_token" value="private"></form>'));
  vi.stubGlobal("fetch", fetch);
  await renewSignIn(l, renewed);
  await renewSignIn(l, renewed);
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(state.get(STATE.lightToken)!)).toMatchObject({ browser: true, refused: false });
  expect(LightToken.load(file)?.refreshToken).toBe("old");
  expect(l.signedOut).toBe(false);
});

it("uses the captured MCAS client rather than the direct authorize path", async () => {
  const { l, state, renewed, file } = setup();
  state.set(STATE.lightToken, JSON.stringify({ at: 1, expiresOn: 2000, refused: false, session: true, mcas: true }));
  const renew = vi.spyOn(McasSession.prototype, "renew").mockResolvedValue({ refreshToken: "mcas-new", clientId: "client", tenantId: "tenant", region: "emea", expiresOn: 87400 });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await renewSignIn(l, renewed);
  expect(renew).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  expect(LightToken.load(file)?.refreshToken).toBe("mcas-new");
  expect(JSON.parse(state.get(STATE.lightToken)!)).toMatchObject({ mcas: true, refused: false });
});
