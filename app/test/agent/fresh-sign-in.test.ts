import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@/agent/context";
import { freshSignIn } from "@/agent/jobs/fresh-sign-in";
import { TEAMS_WEB_CLIENT } from "@/agent/jobs/light-token";
import { LightToken } from "@/agent/light/token";
import { SlotStore } from "@/agent/store/slot-store";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

const rtEntry = (secret: string) => [{ secret, clientId: TEAMS_WEB_CLIENT, homeAccountId: "user.tenant", expiresOn: 0 }];

function agent(sign: { at: number; expiresOn: number; refused: boolean } | null, o: { email?: string; pageRt?: string } = {}) {
  const dir = tempDir();
  const store = SlotStore.open(path.join(dir, "messages.db"));
  const email = o.email ?? "anna@contoso.example";
  if (email) store.setState(STATE.me, JSON.stringify({ name: "Anna", email, tenant: "Contoso", av: "", logo: "" }));
  if (sign) store.setState(STATE.lightToken, JSON.stringify(sign));
  const lightTokenFile = path.join(dir, "light-token.json");
  LightToken.save(lightTokenFile, { refreshToken: "old-rt", clientId: TEAMS_WEB_CLIENT, tenantId: "tenant", region: "emea", expiresOn: sign?.expiresOn ?? 0 });
  const cleared: string[] = [];
  const cdp = { send: vi.fn(async (_m: string, p: { origin: string }) => void cleared.push(p.origin)), detach: vi.fn(async () => undefined) };
  const page = {
    url: () => "https://teams.cloud.microsoft/",
    evaluate: vi.fn(async () => (o.pageRt === undefined ? rtEntry("old-rt") : o.pageRt ? rtEntry(o.pageRt) : [])),
    context: () => ({ newCDPSession: async () => cdp }),
    goto: vi.fn(async () => null),
  };
  return { a: { store, tp: { page }, config: { lightTokenFile } } as unknown as Agent, page, cleared, store };
}

const now = () => Math.floor(Date.now() / 1000);
const refused = () => ({ at: now() - 90_000, expiresOn: now() - 3600, refused: true });

describe("new Microsoft sign-in of a light account's browser", () => {
  it("clears the data of Teams and opens it again for this account, once in a while", async () => {
    const { a, page, cleared, store } = agent(refused());
    expect(await freshSignIn(a)).toBe(true);
    expect(cleared).toEqual(["https://teams.cloud.microsoft", "https://teams.microsoft.com", "https://teams.live.com"]);
    expect(page.goto).toHaveBeenCalledWith("https://teams.cloud.microsoft/?loginHint=anna%40contoso.example", expect.anything());
    expect(Number(store.getState(STATE.freshSignIn))).toBeGreaterThan(0);
    expect(await freshSignIn(a)).toBe(false);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it("does it also when Teams holds no refresh token at all", async () => {
    const { a, page } = agent(refused(), { pageRt: "" });
    expect(await freshSignIn(a)).toBe(true);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it("leaves a sign-in just done to the light-token job: Teams holds a new refresh token", async () => {
    const { a, page, store } = agent(refused(), { pageRt: "new-rt" });
    expect(await freshSignIn(a)).toBe(false);
    expect(page.goto).not.toHaveBeenCalled();
    expect(store.getState(STATE.freshSignIn)).toBe("");
  });

  it("leaves Teams alone while the sign-in holds, and for an account never signed in", async () => {
    const holds = agent({ at: now() - 60, expiresOn: now() + 80_000, refused: false });
    expect(await freshSignIn(holds.a)).toBe(false);
    const fresh = agent(null, { email: "" });
    expect(await freshSignIn(fresh.a)).toBe(false);
    expect(holds.page.goto).not.toHaveBeenCalled();
    expect(fresh.page.goto).not.toHaveBeenCalled();
  });

  it("replaces a sign-in about to end", async () => {
    const { a, page } = agent({ at: now() - 86_000, expiresOn: now() + 30, refused: false });
    expect(await freshSignIn(a)).toBe(true);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it("leaves a captured Microsoft session to HTTP renewal even when the SPA token ended", async () => {
    const { a, page, store } = agent({ at: now() - 86400, expiresOn: 1, refused: false });
    store.setState(STATE.lightToken, JSON.stringify({ at: now() - 86400, expiresOn: 1, refused: false, session: true }));
    expect(await freshSignIn(a)).toBe(false);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("renews a browser-backed session without clearing Microsoft or MCAS login cookies", async () => {
    const { a, page, store, cleared } = agent(refused());
    store.setState(STATE.lightToken, JSON.stringify({ at: now() - 86400, expiresOn: 1, refused: false, session: true, browser: true }));
    page.url = () => "https://teams.cloud.microsoft.mcas.ms/";
    expect(await freshSignIn(a)).toBe(true);
    expect(cleared).toContain("https://teams.cloud.microsoft.mcas.ms");
    expect(cleared.some((u) => u.includes("login.microsoftonline") || u.includes("access.mcas"))).toBe(false);
    const cdp = await page.context().newCDPSession();
    expect(cdp.send.mock.calls.every(([, p]) => !String((p as { storageTypes?: string }).storageTypes).includes("all"))).toBe(true);
  });

  it("forces a new sign-in for detected MCAS after refusal, even before the browser flag was captured", async () => {
    const { a, page, store } = agent(refused(), { pageRt: "rt-rotated" });
    store.setState(STATE.lightToken, JSON.stringify({ at: now() - 1000, expiresOn: now() + 3600, refused: true, session: true }));
    page.url = () => "https://teams.cloud.microsoft.mcas.ms/";
    expect(await freshSignIn(a)).toBe(true);
  });
});
