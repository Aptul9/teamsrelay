import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/mcp/route";
import { appDb, claimSlot, migrateAppSchema } from "@/lib/appdb";
import { createSlotDb, tempDir } from "./helpers";

const TOKEN = "0123456789abcdef".repeat(4);
const MCP_URL = "http://localhost:8090/mcp";
let slot: number;

beforeAll(() => {
  const dataDir = tempDir();
  process.env.APP_DB = path.join(dataDir, "app.db");
  process.env.ADMIN_EMAIL = "admin@teamsrelay.test";
  migrateAppSchema(appDb());
  // better-auth's user table, as far as /mcp reads it
  appDb().exec('CREATE TABLE IF NOT EXISTS "user"(id TEXT PRIMARY KEY, email TEXT NOT NULL)');
  appDb().prepare('INSERT INTO "user"(id, email) VALUES(?, ?)').run("admin-id", "admin@teamsrelay.test");
  slot = claimSlot(appDb(), "admin-id", { slotCount: 4, perUser: 4 });
  claimSlot(appDb(), "someone-else", { slotCount: 4, perUser: 4 });
  const db = createSlotDb(path.join(dataDir, String(slot), "messages.db"));
  db.prepare("INSERT INTO chats(name, preview, pos, tm, unread, mention, muted) VALUES('BIANCHI Luca', 'Hi', 0, '14:07', 1, 0, 0)").run();
  db.prepare("INSERT INTO chat_messages(chat, idx, mid, author, text, mine, reacts, extra) VALUES('BIANCHI Luca', 0, '1790431664072', 'BIANCHI Luca', 'Hi', 0, '', '')").run();
  db.close();
});

beforeEach(() => {
  process.env.MCP_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.MCP_TOKEN;
});

const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
const post = (headers: Record<string, string>) =>
  POST(new Request(MCP_URL, { method: "POST", body: initialize, headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers } }), undefined);

describe("POST /mcp", () => {
  it("without MCP_TOKEN takes OAuth tokens only: 401 pointing to the OAuth metadata", async () => {
    delete process.env.MCP_TOKEN;
    const r = await post({ Authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  it("is off without MCP_TOKEN when OAuth cannot be: plain HTTP on another host, 404", async () => {
    delete process.env.MCP_TOKEN;
    process.env.APP_URL = "http://teams.lan:8090";
    try {
      expect((await post({ Authorization: `Bearer ${TOKEN}` })).status).toBe(404);
    } finally {
      delete process.env.APP_URL;
    }
  });

  it("wants the token: 401 with a challenge, session cookies ignored", async () => {
    const refused: Record<string, string>[] = [{}, { Authorization: "Bearer wrong" }, { Authorization: TOKEN }, { Cookie: "better-auth.session_token=x" }];
    for (const headers of refused) {
      const r = await post(headers);
      expect(r.status, JSON.stringify(headers)).toBe(401);
      // a value with no scheme gets the DPoP challenge of better-auth
      expect(r.headers.get("www-authenticate")).toMatch(/^(Bearer|DPoP) /);
    }
  });

  it("refuses requests from web pages: 403", async () => {
    expect((await post({ Authorization: `Bearer ${TOKEN}`, Origin: "https://example.com" })).status).toBe(403);
  });
});

async function connect(mode: "legacy" | "auto") {
  const client = new Client({ name: "vitest", version: "1.0.0" }, { versionNegotiation: { mode } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      fetch: async (url, init) => POST(new Request(url, init), undefined),
    }),
  );
  return client;
}

describe.each([
  ["legacy", "2025-11-25"],
  ["auto", "2026-07-28"],
] as const)("MCP client, version negotiation %s", (mode, version) => {
  it(`lists the five tools over ${version}, only refresh_chat not read-only`, async () => {
    const client = await connect(mode);
    expect(client.getNegotiatedProtocolVersion()).toBe(version);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_accounts", "list_activity", "list_chats", "read_chat", "refresh_chat"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(t.name !== "refresh_chat");
    await client.close();
  });

  it("reads the chats of the administrator of .env", async () => {
    const client = await connect(mode);
    const r = await client.callTool({ name: "read_chat", arguments: { chat: "BIANCHI Luca" } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ account: slot, chat: "BIANCHI Luca", messages: [{ id: "1790431664072", time: "2026-09-26T14:07:44.072Z", text: "Hi" }] });
    expect(JSON.parse((r.content as { text: string }[])[0].text)).toEqual(r.structuredContent);
    await client.close();
  });

  it("answers the account of another user with an error result", async () => {
    const client = await connect(mode);
    const r = await client.callTool({ name: "list_chats", arguments: { account: slot + 1 } });
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: "text", text: "Account not found" }]);
    await client.close();
  });
});
