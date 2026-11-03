import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IC3, LightToken, SignedOut } from "@/agent/light/token";
import { tempDir } from "../helpers";

const stored = { refreshToken: "rt-1", clientId: "client-1", tenantId: "tenant-1", region: "emea", expiresOn: 2_000 };

function setup(now = () => 1_000_000) {
  const file = path.join(tempDir(), "light-token.json");
  LightToken.save(file, stored);
  return { file, token: new LightToken(file, now) };
}

const granted = (access: string, rolled = "rt-2", expiresIn = 4771) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ access_token: access, refresh_token: rolled, expires_in: expiresIn }) }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("light account token", () => {
  it("redeems the refresh token at the tenant's token endpoint as Teams web does", async () => {
    const fetch = granted("at-1");
    vi.stubGlobal("fetch", fetch);
    const { token } = setup();
    expect(await token.accessToken(IC3)).toBe("at-1");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    expect((init.headers as Record<string, string>).Origin).toBe("https://teams.microsoft.com");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    expect(body.get("client_id")).toBe("client-1");
    expect(body.get("scope")).toContain(IC3);
    expect(body.get("scope")).toContain("offline_access");
  });

  it("serves the cached token until 5 minutes before it expires, then renews", async () => {
    let now = 1_000_000;
    const fetch = granted("at-1");
    vi.stubGlobal("fetch", fetch);
    const { token } = setup(() => now);
    await token.accessToken(IC3);
    now += 4771_000 - 6 * 60_000;
    await token.accessToken(IC3);
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 2 * 60_000;
    await token.accessToken(IC3);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the rolled refresh token for the next renewal, with the expiry of the first", async () => {
    vi.stubGlobal("fetch", granted("at-1", "rt-rolled"));
    const { file, token } = setup();
    await token.accessToken(IC3);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.refreshToken).toBe("rt-rolled");
    expect(saved.expiresOn).toBe(2_000);
  });

  it("redeems again after renewAll, though the cached token still holds", async () => {
    const fetch = granted("at-1");
    vi.stubGlobal("fetch", fetch);
    const { token } = setup();
    await token.accessToken(IC3);
    token.renewAll();
    await token.accessToken(IC3);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("serves a token still valid when Microsoft refuses the renewal", async () => {
    let now = 1_000_000;
    vi.stubGlobal("fetch", granted("at-1"));
    const { token } = setup(() => now);
    await token.accessToken(IC3);
    now += 4771_000 - 60_000;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) })));
    expect(await token.accessToken(IC3)).toBe("at-1");
    now += 2 * 60_000;
    await expect(token.accessToken(IC3)).rejects.toBeInstanceOf(SignedOut);
  });

  it.skipIf(process.platform === "win32")("writes the token file readable by its owner only", async () => {
    vi.stubGlobal("fetch", granted("at-1"));
    const { file, token } = setup();
    await token.accessToken(IC3);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("is signed out when Microsoft refuses the refresh token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) })));
    const { token } = setup();
    await expect(token.accessToken(IC3)).rejects.toBeInstanceOf(SignedOut);
  });

  it("is signed out with no refresh token stored", async () => {
    const token = new LightToken(path.join(tempDir(), "light-token.json"));
    await expect(token.accessToken(IC3)).rejects.toBeInstanceOf(SignedOut);
  });

  it("never puts a token in an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "server_error" }) })));
    const { token } = setup();
    const e = await token.accessToken(IC3).catch((x: Error) => x);
    expect(String(e)).not.toContain("rt-1");
  });
});
