// The browser tools of /mcp (src/lib/mcp/browser.ts), with a fake hub on globalThis: listed only for an OAuth client of
// a user with a relay connected with its browser on, each with `account`; every refusal of the spec, in its order; the
// call forwarded without `account` and its answer as it came; one row of browser_actions per call.
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appDb, browserActionsOf, claimSlot, logBrowserAction, migrateAppSchema, setBrowserOff } from "@/lib/appdb";
import { BROWSER_HUB_KEY, type BrowserHub, type BrowserTool, type ToolResult } from "@/lib/browser-hub";
import { mcpServer } from "@/lib/mcp/server";
import { addRelayAccount } from "@/lib/slots";
import { tempDir } from "./helpers";

const READ_TOOLS = ["list_accounts", "list_activity", "list_chats", "read_chat", "refresh_chat"];
const TOOLS: BrowserTool[] = [
  { name: "browser_navigate", description: "Navigate to a URL", inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } },
  { name: "browser_take_screenshot", description: "Take a screenshot", inputSchema: { type: "object", properties: { fullPage: { type: "boolean" } }, additionalProperties: false } },
  { name: "browser_close", description: "Close the page", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];

let dataDir: string;
// u1: relay 1 connected, container 2, relay 3 connected but switched off, relay 4 not connected. u2: relay 5 connected.
const slots: Record<string, number> = {};
const connected = new Set<number>();
const calls: { slot: number; name: string; args: Record<string, unknown> }[] = [];
let answer: ToolResult = { content: [{ type: "text", text: "ok" }] };

beforeAll(async () => {
  dataDir = tempDir();
  process.env.APP_DB = path.join(dataDir, "app.db");
  migrateAppSchema(appDb());
  const o = { db: appDb(), dataDir, slotCount: 10, perUser: 10 };
  slots.relay = (await addRelayAccount("u1", o)).slot;
  slots.container = claimSlot(appDb(), "u1", { slotCount: 10, perUser: 10 });
  slots.off = (await addRelayAccount("u1", o)).slot;
  slots.offline = (await addRelayAccount("u1", o)).slot;
  slots.other = (await addRelayAccount("u2", o)).slot;
  setBrowserOff(appDb(), slots.off, true);
  for (const s of [slots.relay, slots.off, slots.other]) connected.add(s);
  const hub: BrowserHub = {
    tools: (slot) => (connected.has(slot) ? TOOLS : null),
    call: async (slot, name, args) => {
      calls.push({ slot, name, args });
      return answer;
    },
  };
  (globalThis as Record<string, unknown>)[BROWSER_HUB_KEY] = hub;
});

afterAll(() => {
  delete (globalThis as Record<string, unknown>)[BROWSER_HUB_KEY];
});

beforeEach(() => {
  calls.length = 0;
  answer = { content: [{ type: "text", text: "ok" }] };
});

async function connect(userId: string, clientId?: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcpServer(userId, { clientId }).connect(b);
  const client = new Client({ name: "vitest", version: "1.0.0" });
  await client.connect(a);
  return client;
}

const rows = (slot: number) => browserActionsOf(appDb(), slot);
const text = (r: { content: unknown }) => (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");

describe("the list of tools", () => {
  it("adds the tools of the connected relays to the read tools, for an OAuth client, each with account", async () => {
    const client = await connect("u1", "client-a");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...TOOLS.map((t) => t.name)].sort());
    const nav = tools.find((t) => t.name === "browser_navigate")!;
    expect(nav.inputSchema.required).toEqual(["account", "url"]);
    expect(nav.inputSchema.properties).toHaveProperty("url");
    expect(JSON.stringify(nav.inputSchema.properties?.account)).toContain(`${slots.relay}`);
    // the switched-off relay is not offered
    expect(JSON.stringify(nav.inputSchema.properties?.account)).not.toContain(`${slots.off}`);
    expect(nav.description).toMatch(/Navigate to a URL/);
    expect(nav.description).toMatch(/relay/);
  });

  it("gives the read tools only to MCP_TOKEN, and a browser tool called by name is unknown", async () => {
    const client = await connect("u1");
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(READ_TOOLS);
    const outcome = await client.callTool({ name: "browser_navigate", arguments: { account: slots.relay, url: "https://example.com/" } }).then(
      (r) => (r.isError ? text(r) : "ran"),
      (e: Error) => e.message,
    );
    expect(outcome).toMatch(/not found|unknown/i);
    expect(calls).toEqual([]);
  });

  it("gives the read tools only when no relay of the user is connected with its browser on", async () => {
    connected.delete(slots.relay);
    try {
      const client = await connect("u1", "client-a");
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(READ_TOOLS);
    } finally {
      connected.add(slots.relay);
    }
  });
});

describe("a browser call", () => {
  it("goes to the relay without account, and its answer comes back as it came, images included", async () => {
    answer = { content: [{ type: "text", text: "### Page" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] };
    const client = await connect("u1", "client-a");
    const r = await client.callTool({ name: "browser_navigate", arguments: { account: slots.relay, url: "https://www.wikipedia.org/wiki/Teleprinter" } });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual(answer.content);
    expect(calls).toEqual([{ slot: slots.relay, name: "browser_navigate", args: { url: "https://www.wikipedia.org/wiki/Teleprinter" } }]);
    expect(rows(slots.relay)[0]).toMatchObject({ user_id: "u1", client_id: "client-a", slot: slots.relay, tool: "browser_navigate", host: "www.wikipedia.org", outcome: "ok" });
  });

  it("writes error as the outcome of a tool that failed on the relay", async () => {
    answer = { content: [{ type: "text", text: "### Error" }], isError: true };
    const client = await connect("u1", "client-a");
    const r = await client.callTool({ name: "browser_close", arguments: { account: slots.relay } });
    expect(r.isError).toBe(true);
    expect(rows(slots.relay)[0]).toMatchObject({ tool: "browser_close", host: "", outcome: "error" });
  });

  it("refuses an account of another user as not found, and writes nothing under it", async () => {
    const client = await connect("u1", "client-a");
    const r = await client.callTool({ name: "browser_navigate", arguments: { account: slots.other, url: "https://example.com/" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not found/i);
    expect(calls).toEqual([]);
    expect(rows(slots.other)).toEqual([]);
  });

  it("refuses, naming the account, one that is not on another computer, switched off, or not connected", async () => {
    const client = await connect("u1", "client-a");
    for (const [key, outcome, why] of [
      ["container", "not-relay", /another computer/],
      ["off", "off", /stopped|switched off/i],
      ["offline", "offline", /not connected/],
    ] as const) {
      const r = await client.callTool({ name: "browser_close", arguments: { account: slots[key] } }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
      expect(r.isError, key).toBe(true);
      expect(text(r), key).toMatch(why);
      expect(text(r), key).toContain(`${slots[key]}`);
      expect(rows(slots[key])[0], key).toMatchObject({ tool: "browser_close", outcome });
    }
    expect(calls).toEqual([]);
  });
});

describe("browser_actions", () => {
  it("keeps the last 50 of an account for Settings, newest first", () => {
    const db = appDb();
    for (let i = 0; i < 60; i++) logBrowserAction(db, { userId: "u1", clientId: "c", slot: slots.offline, tool: `t${i}`, host: "", outcome: "ok" }, 1_790_000_000_000 + i);
    const shown = browserActionsOf(db, slots.offline);
    expect(shown).toHaveLength(50);
    expect(shown[0].tool).toBe("t59");
    expect(shown[49].tool).toBe("t10");
  });
});
