import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { errorText, log } from "@/agent/log";

// Playwright MCP (@playwright/mcp) in the relay process, for the browser of the MCP clients of the owner. The relay is
// its client: it opens the session itself, without the roots capability (Playwright MCP would take the first root as
// its working folder), and passes on tools/list and tools/call (browser-link.ts, after the allowlist). The browser is
// a second browser on a profile of its own, launched at the first tool call with the Playwright that @playwright/mcp
// brings (each release pins its own; the relay's copy never drives it), so that the relay can close it: after the idle
// time and at stop, with the Playwright MCP server, and the screenshots it saved.

// what the relay asks of a browser context: the type comes from the other Playwright
type AiContext = { close(): Promise<void> };
type McpServer = { connect(transport: unknown): Promise<void>; close(): Promise<void> };

export type McpModule = {
  createConnection(config: object, getContext: () => Promise<unknown>): Promise<McpServer>;
  launch(profileDir: string, channel: string): Promise<AiContext>;
};

export type HostOptions = { profileDir: string; outputDir: string; channel: string; idleMs: number; load?: () => McpModule };

// the answer of Playwright MCP to one request: its result, or its JSON-RPC error
export type HostAnswer = { result?: unknown; error?: unknown };

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };

// Tools and folders as the spec sets them: navigation, tabs and input only; no file outside the output folder, and
// that one capped; actions answer without a snapshot (Playwright MCP writes it to a file otherwise), browser_snapshot
// gives it in the answer; screenshots come back as images
const OUTPUT_MAX = 20 * 1024 * 1024;
const config = (outputDir: string) => ({
  capabilities: ["core", "core-navigation", "core-tabs", "core-input"],
  allowUnrestrictedFileAccess: false,
  outputDir,
  outputMaxSize: OUTPUT_MAX,
  imageResponses: "allow",
  snapshot: { mode: "none" },
});

// @playwright/mcp and its own playwright-core, loaded at the first use: a relay with the browser off never loads them
export function loadPlaywrightMcp(): McpModule {
  const req = createRequire(__filename);
  const mcp = req("@playwright/mcp") as { createConnection(config: object, getContext: () => Promise<unknown>): Promise<McpServer> };
  const mcpDir = path.dirname(req.resolve("@playwright/mcp/package.json"));
  const { chromium } = req(req.resolve("playwright-core", { paths: [mcpDir] })) as {
    chromium: { launchPersistentContext(dir: string, o: { channel: string; headless: boolean }): Promise<AiContext> };
  };
  return {
    createConnection: (c, getContext) => mcp.createConnection(c, getContext),
    launch: (profileDir, channel) => chromium.launchPersistentContext(profileDir, { channel, headless: false }),
  };
}

// The relay's end of the session, in process: requests go to the server through onmessage, its answers come to send
class PipeTransport {
  onmessage?: (m: Msg) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  private readonly pending = new Map<number, (m: Msg) => void>();
  private next = 1;

  async start() {}

  async send(m: Msg) {
    if (m.method === undefined && typeof m.id === "number") {
      const done = this.pending.get(m.id);
      this.pending.delete(m.id);
      done?.(m);
      return;
    }
    // a request of the server to its client (roots, sampling...): the relay offers none. Notifications (the list of
    // tools changed) need nothing.
    if (m.method !== undefined && m.id !== undefined) this.onmessage?.({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Not offered by the relay" } });
  }

  async close() {
    for (const done of this.pending.values()) done({ jsonrpc: "2.0", error: { code: -32000, message: "Playwright MCP closed" } });
    this.pending.clear();
    this.onclose?.();
  }

  request(method: string, params?: unknown): Promise<HostAnswer> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.pending.set(id, (m) => resolve(m.error !== undefined ? { error: m.error } : { result: m.result }));
      this.onmessage?.({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string) {
    this.onmessage?.({ jsonrpc: "2.0", method });
  }
}

type Session = { server: McpServer; transport: PipeTransport; context: AiContext | null };

export class BrowserHost {
  private session: Promise<Session> | null = null;
  private busy = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: HostOptions) {}

  // a Playwright MCP server is up (its browser may not be yet)
  get open(): boolean {
    return this.session !== null;
  }

  async request(method: "tools/list" | "tools/call", params: unknown): Promise<HostAnswer> {
    this.busy++;
    this.stopIdle();
    try {
      const s = await (this.session ??= this.start());
      return await s.transport.request(method, params);
    } finally {
      // the idle time counts from the end of the last request
      if (--this.busy === 0 && this.session) {
        this.idle = setTimeout(() => void this.close(), this.o.idleMs);
        this.idle.unref?.();
      }
    }
  }

  // The browser first, then the server; the screenshots it saved go with them. The profile stays.
  async close() {
    this.stopIdle();
    const pending = this.session;
    this.session = null;
    const s = await pending?.catch(() => null);
    if (!s) return;
    if (s.context) await s.context.close().catch((e: unknown) => log.warn("ai-browser", `close: ${errorText(e)}`));
    await s.server.close().catch((e: unknown) => log.warn("ai-browser", `close of Playwright MCP: ${errorText(e)}`));
    fs.rmSync(this.o.outputDir, { recursive: true, force: true });
    log.info("ai-browser", s.context ? "closed" : "Playwright MCP closed");
  }

  private stopIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  private async start(): Promise<Session> {
    try {
      const mod = (this.o.load ?? loadPlaywrightMcp)();
      const transport = new PipeTransport();
      const session = { transport, context: null } as unknown as Session;
      // Playwright MCP asks for the context at its first tool call, and again after the browser was closed
      session.server = await mod.createConnection(config(this.o.outputDir), async () => {
        const context = await mod.launch(this.o.profileDir, this.o.channel);
        session.context = context;
        log.info("ai-browser", "started", { profile: this.o.profileDir });
        return context;
      });
      await session.server.connect(transport);
      const init = await transport.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teamsrelay-relay", version: "1.0.0" } });
      if (init.error !== undefined) throw new Error(`Playwright MCP refused the session: ${JSON.stringify(init.error)}`);
      transport.notify("notifications/initialized");
      return session;
    } catch (e) {
      this.session = null;
      throw e;
    }
  }
}
