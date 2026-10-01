// Playwright MCP in the relay process, with a fake of it: the relay opens the session itself, launches the browser
// only at the first tool call, and closes browser and server after the idle time; the next call starts both again.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserHost, type McpModule } from "@/local/browser-host";
import { tempDir } from "../helpers";

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
type FakeTransport = { onmessage?: (m: Msg) => void; send(m: Msg): Promise<void>; start(): Promise<void>; close(): Promise<void> };

function fakeMcp() {
  const seen: Msg[] = [];
  const events: string[] = [];
  let launches = 0;
  let config: Record<string, unknown> = {};
  const mod: McpModule = {
    async createConnection(c, getContext) {
      config = c as Record<string, unknown>;
      events.push("server");
      let context: Promise<unknown> | null = null;
      return {
        async connect(t: FakeTransport) {
          await t.start();
          t.onmessage = (m: Msg) => {
            seen.push(m);
            if (m.id === undefined) return;
            const reply = (result: unknown) => void t.send({ jsonrpc: "2.0", id: m.id, result });
            if (m.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "api", version: "x" } });
            if (m.method === "tools/list") return reply({ tools: [{ name: "browser_navigate", inputSchema: { type: "object" } }] });
            if (m.method === "tools/call") {
              context ??= getContext();
              void context.then(async () => {
                // a server-to-client notification on the way, as Playwright MCP sends one
                await t.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
                const wait = Number((m.params?.arguments as { wait?: number } | undefined)?.wait ?? 0);
                setTimeout(() => reply({ content: [{ type: "text", text: `ran ${String(m.params?.name)}` }] }), wait);
              });
            }
          };
        },
        async close() {
          events.push("server closed");
        },
      };
    },
    async launch(profileDir, channel) {
      launches++;
      events.push(`launch ${channel} ${path.basename(profileDir)}`);
      return {
        async close() {
          events.push("browser closed");
        },
      };
    },
  };
  return { mod, seen, events, launches: () => launches, config: () => config };
}

const hosts: BrowserHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
});

function host(fake: ReturnType<typeof fakeMcp>, idleMs = 60_000) {
  const dir = tempDir();
  const h = new BrowserHost({ profileDir: path.join(dir, "ai-profile"), outputDir: path.join(dir, "ai-output"), channel: "chrome", idleMs, load: () => fake.mod });
  hosts.push(h);
  return { h, dir };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the session with Playwright MCP", () => {
  it("is opened by the relay: initialize without roots, then initialized, before the first request", async () => {
    const fake = fakeMcp();
    const { h } = host(fake);
    const r = await h.request("tools/list", {});
    expect(r).toEqual({ result: { tools: [{ name: "browser_navigate", inputSchema: { type: "object" } }] } });
    expect(fake.seen.map((m) => m.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(fake.seen[0].params).toMatchObject({ capabilities: {} });
    expect(fake.seen[0].params?.capabilities).not.toHaveProperty("roots");
  });

  it("configures Playwright MCP: own capabilities, no file access, snapshots in the answers only, images in them", async () => {
    const fake = fakeMcp();
    const { h, dir } = host(fake);
    await h.request("tools/list", {});
    expect(fake.config()).toEqual({
      capabilities: ["core", "core-navigation", "core-tabs", "core-input"],
      allowUnrestrictedFileAccess: false,
      outputDir: path.join(dir, "ai-output"),
      outputMaxSize: 20 * 1024 * 1024,
      imageResponses: "allow",
      snapshot: { mode: "none" },
    });
  });

  it("launches no browser for the list of tools, one at the first tool call, on its own profile", async () => {
    const fake = fakeMcp();
    const { h } = host(fake);
    await h.request("tools/list", {});
    expect(fake.launches()).toBe(0);
    expect(await h.request("tools/call", { name: "browser_navigate", arguments: {} })).toEqual({ result: { content: [{ type: "text", text: "ran browser_navigate" }] } });
    await h.request("tools/call", { name: "browser_snapshot", arguments: {} });
    expect(fake.events.filter((e) => e.startsWith("launch"))).toEqual(["launch chrome ai-profile"]);
  });

  it("matches each answer to its request when calls overlap", async () => {
    const fake = fakeMcp();
    const { h } = host(fake);
    const slow = h.request("tools/call", { name: "browser_wait_for", arguments: { wait: 80 } });
    const fast = h.request("tools/call", { name: "browser_snapshot", arguments: {} });
    expect(await fast).toEqual({ result: { content: [{ type: "text", text: "ran browser_snapshot" }] } });
    expect(await slow).toEqual({ result: { content: [{ type: "text", text: "ran browser_wait_for" }] } });
  });
});

describe("idle close", () => {
  it("closes the browser and the server after the idle time, empties the output folder, starts again at the next call", async () => {
    const fake = fakeMcp();
    const { h, dir } = host(fake, 150);
    await h.request("tools/call", { name: "browser_navigate", arguments: {} });
    fs.mkdirSync(path.join(dir, "ai-output"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ai-output", "page.png"), "png");
    expect(h.open).toBe(true);
    await sleep(400);
    expect(h.open).toBe(false);
    expect(fake.events).toEqual(["server", "launch chrome ai-profile", "browser closed", "server closed"]);
    expect(fs.existsSync(path.join(dir, "ai-output", "page.png"))).toBe(false);
    await h.request("tools/call", { name: "browser_navigate", arguments: {} });
    expect(fake.launches()).toBe(2);
    expect(fake.seen.filter((m) => m.method === "initialize")).toHaveLength(2);
  });

  it("counts from the end of the last call: a long call keeps the browser open", async () => {
    const fake = fakeMcp();
    const { h } = host(fake, 150);
    await h.request("tools/call", { name: "browser_wait_for", arguments: { wait: 350 } });
    expect(h.open).toBe(true);
    await sleep(100);
    expect(h.open).toBe(true);
    await sleep(250);
    expect(h.open).toBe(false);
  });

  it("closes what is open on close(), and a server that never launched a browser", async () => {
    const fake = fakeMcp();
    const { h } = host(fake);
    await h.request("tools/list", {});
    await h.close();
    expect(fake.events).toEqual(["server", "server closed"]);
    expect(h.open).toBe(false);
  });
});
