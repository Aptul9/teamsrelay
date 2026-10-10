// What Settings reads and changes about the browser of a relay and the MCP clients of a user: the switch and the last
// actions of an account (its owner only), the clients the user allowed, and Revoke.
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as browserRoute from "@/app/api/accounts/[slot]/browser/route";
import * as clientRoute from "@/app/api/oauth/clients/[id]/route";
import * as clientsRoute from "@/app/api/oauth/clients/route";
import { appDb, claimSlot, logBrowserAction, migrateAppSchema, slotRow } from "@/lib/appdb";
import { BROWSER_HUB_KEY } from "@/lib/browser-hub";
import { requireUser } from "@/lib/session";
import { addRelayAccount } from "@/lib/slots";
import { tempDir } from "./helpers";

// The session is better-auth's: here it is the user the test names
vi.mock("@/lib/session", () => ({ requireUser: vi.fn() }));
const as = (id: string) => vi.mocked(requireUser).mockResolvedValue({ id, email: `${id}@contoso.example`, name: id });

let relay: number;
let container: number;

beforeAll(async () => {
  const dataDir = tempDir();
  process.env.APP_DB = path.join(dataDir, "app.db");
  migrateAppSchema(appDb());
  relay = (await addRelayAccount("u1", { db: appDb(), dataDir, perUser: 6 })).slot;
  container = claimSlot(appDb(), "u1", { perUser: 6 });
  // the tables of the OAuth plugin, as far as these routes read them
  appDb().exec(`
    CREATE TABLE oauthClient(id TEXT PRIMARY KEY, clientId TEXT, name TEXT);
    CREATE TABLE oauthConsent(id TEXT PRIMARY KEY, clientId TEXT, userId TEXT, createdAt TEXT);
    CREATE TABLE oauthRefreshToken(id TEXT PRIMARY KEY, clientId TEXT, userId TEXT);
    CREATE TABLE oauthAccessToken(id TEXT PRIMARY KEY, clientId TEXT, userId TEXT);
    INSERT INTO oauthClient VALUES ('1', 'c-code', 'Claude Code'), ('2', 'c-open', 'opencode');
    INSERT INTO oauthConsent VALUES ('k1', 'c-code', 'u1', '2026-10-01T10:00:00.000Z'), ('k2', 'c-open', 'u1', '2026-10-01T11:00:00.000Z'), ('k3', 'c-code', 'u2', '2026-10-01T12:00:00.000Z');
    INSERT INTO oauthRefreshToken VALUES ('r1', 'c-code', 'u1'), ('r2', 'c-code', 'u2');
    INSERT INTO oauthAccessToken VALUES ('a1', 'c-code', 'u1');
  `);
  logBrowserAction(appDb(), { userId: "u1", clientId: "c-code", slot: relay, tool: "browser_navigate", host: "www.wikipedia.org", outcome: "ok" }, 1_790_000_000_000);
  logBrowserAction(appDb(), { userId: "u1", clientId: "c-gone", slot: relay, tool: "browser_snapshot", host: "", outcome: "offline" }, 1_790_000_001_000);
});

const ctx = (slot: number) => ({ params: Promise.resolve({ slot: String(slot) }) });
const req = (method: string, body?: unknown) =>
  new Request("http://localhost:8090/api/x", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("GET /api/accounts/N/browser", () => {
  it("gives the owner the switch, whether its relay is connected, and the last actions with the name of each client", async () => {
    as("u1");
    (globalThis as Record<string, unknown>)[BROWSER_HUB_KEY] = { tools: (n: number) => (n === relay ? [] : null), call: async () => ({ content: [] }) };
    try {
      const r = await browserRoute.GET(req("GET"), ctx(relay));
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({
        off: false,
        connected: true,
        actions: [
          { ts: 1_790_000_001_000, client: "c-gone", tool: "browser_snapshot", host: "", outcome: "offline" },
          { ts: 1_790_000_000_000, client: "Claude Code", tool: "browser_navigate", host: "www.wikipedia.org", outcome: "ok" },
        ],
      });
    } finally {
      delete (globalThis as Record<string, unknown>)[BROWSER_HUB_KEY];
    }
  });

  it("is not found for another user, administrators included", async () => {
    as("u2");
    expect((await browserRoute.GET(req("GET"), ctx(relay))).status).toBe(404);
    expect((await browserRoute.GET(req("GET"), ctx(99))).status).toBe(404);
  });
});

describe("PATCH /api/accounts/N/browser", () => {
  it("switches the browser of the relay off and on again", async () => {
    as("u1");
    expect((await browserRoute.PATCH(req("PATCH", { off: true }), ctx(relay))).status).toBe(200);
    expect(slotRow(appDb(), relay)?.browser_off).toBe(1);
    expect((await browserRoute.PATCH(req("PATCH", { off: false }), ctx(relay))).status).toBe(200);
    expect(slotRow(appDb(), relay)?.browser_off).toBe(0);
  });

  it("wants true or false, an account on another computer, and its owner", async () => {
    as("u1");
    expect((await browserRoute.PATCH(req("PATCH", { off: "yes" }), ctx(relay))).status).toBe(400);
    expect((await browserRoute.PATCH(req("PATCH", { off: true }), ctx(container))).status).toBe(409);
    as("u2");
    expect((await browserRoute.PATCH(req("PATCH", { off: true }), ctx(relay))).status).toBe(404);
    expect(slotRow(appDb(), relay)?.browser_off).toBe(0);
  });
});

describe("MCP clients of the user", () => {
  it("lists the clients the user allowed, newest first", async () => {
    as("u1");
    const r = await clientsRoute.GET(req("GET"), undefined);
    expect(await r.json()).toEqual({
      clients: [
        { clientId: "c-open", name: "opencode", since: "2026-10-01T11:00:00.000Z" },
        { clientId: "c-code", name: "Claude Code", since: "2026-10-01T10:00:00.000Z" },
      ],
    });
  });

  it("revokes one client of this user only: its consent and its tokens", async () => {
    as("u1");
    const r = await clientRoute.DELETE(req("DELETE"), { params: Promise.resolve({ id: "c-code" }) });
    expect(r.status).toBe(200);
    const db = appDb();
    expect(db.prepare("SELECT userId FROM oauthConsent WHERE clientId='c-code'").pluck().all()).toEqual(["u2"]);
    expect(db.prepare("SELECT userId FROM oauthRefreshToken").pluck().all()).toEqual(["u2"]);
    expect(db.prepare("SELECT COUNT(*) FROM oauthAccessToken").pluck().get()).toBe(0);
    expect(((await (await clientsRoute.GET(req("GET"), undefined)).json()) as { clients: { clientId: string }[] }).clients.map((c) => c.clientId)).toEqual(["c-open"]);
  });
});
