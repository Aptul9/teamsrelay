import { Agent } from "undici";
import { errorText, log } from "@/agent/log";
import { MAX_BROWSER_MESSAGE, RELAY_BROWSER_PATH } from "@/shared/relay-sync";
import { screenRequest, screenTools, type RpcRequest } from "./browser-allowlist";
import type { HostAnswer } from "./browser-host";
import { openLink, type LinkSocket, type OpenSocket } from "./link-socket";

// The browser of this relay for the MCP clients of the owner, as the server reaches it: a websocket the relay opens to
// the server it joined (/api/relay/browser/socket, src/server/browser-hub.ts), with its token. The server sends
// tools/list and tools/call as JSON-RPC requests; each passes the allowlist (browser-allowlist.ts) before Playwright MCP
// sees it, and each answer goes back with the id it came with. One call at a time. Nothing listens on this computer.

// a socket lost opens again after this long, doubled each time up to the longest, as the sync of the relay does
const RETRY_FIRST_MS = 1000;
const RETRY_LONGEST_MS = 30_000;

export type BrowserLinkOptions = {
  // the server the relay joined, and its token
  url: string;
  token: string;
  host: { request(method: "tools/list" | "tools/call", params: unknown): Promise<HostAnswer>; close(): Promise<void> };
  open?: OpenSocket;
};

// the host of a URL a call opens, for the log; "" for the other tools
function hostOf(r: RpcRequest): string {
  const args = (r.params?.arguments ?? {}) as { url?: unknown };
  try {
    return typeof args.url === "string" ? new URL(args.url).host : "";
  } catch {
    return "";
  }
}

export class BrowserLink {
  private socket: LinkSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private wait = RETRY_FIRST_MS;
  private stopped = false;
  // calls run one after the other, in the order they came
  private queue: Promise<void> = Promise.resolve();
  private readonly agent = new Agent({ allowH2: false });

  constructor(private readonly o: BrowserLinkOptions) {}

  start() {
    log.info("ai-browser", "on: MCP clients of the server drive a browser of its own here");
    this.connect();
  }

  async stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const s = this.socket;
    this.socket = null;
    s?.close();
    await this.queue.catch(() => undefined);
    await this.o.host.close();
    await this.agent.close().catch(() => undefined);
  }

  private connect() {
    if (this.socket || this.stopped) return;
    try {
      this.socket = openLink(
        { server: this.o.url, path: RELAY_BROWSER_PATH, token: this.o.token, dispatcher: this.agent, open: this.o.open, current: () => this.socket },
        {
          open: () => {
            this.wait = RETRY_FIRST_MS;
            log.info("ai-browser", "socket to the server open");
          },
          message: (s, data) => this.received(s, data),
          close: () => {
            this.socket = null;
            this.again();
          },
        },
      );
    } catch (e) {
      log.warn("ai-browser", `socket: ${errorText(e)}`);
      this.again();
    }
  }

  private again() {
    if (this.stopped) return;
    const wait = this.wait;
    this.wait = Math.min(RETRY_LONGEST_MS, this.wait * 2);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, wait);
  }

  private received(s: LinkSocket, data: unknown) {
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    const screened = screenRequest(msg);
    if (!screened.ok) {
      const name = (msg as { params?: { name?: unknown } })?.params?.name;
      const reply = screened.reply as { result?: { content?: { text?: unknown }[] }; error?: { message?: unknown } } | null;
      const why = reply?.result?.content?.[0]?.text ?? reply?.error?.message;
      log.warn("ai-browser", "refused", { method: String((msg as { method?: unknown })?.method ?? ""), tool: typeof name === "string" ? name : undefined, why: typeof why === "string" ? why : undefined });
      if (screened.reply) this.send(s, screened.reply);
      return;
    }
    const r = screened.request;
    this.queue = this.queue.then(() => this.run(s, r));
  }

  private async run(s: LinkSocket, r: RpcRequest) {
    const tool = r.method === "tools/call" ? String(r.params?.name) : "";
    if (tool) log.info("ai-browser", "call", { tool, host: hostOf(r) || undefined });
    let answer: HostAnswer;
    try {
      answer = await this.o.host.request(r.method as "tools/list" | "tools/call", r.params ?? {});
    } catch (e) {
      answer = { error: { code: -32603, message: errorText(e) } };
    }
    let out =
      answer.error !== undefined
        ? JSON.stringify({ jsonrpc: "2.0", id: r.id, error: answer.error })
        : JSON.stringify({ jsonrpc: "2.0", id: r.id, result: r.method === "tools/list" ? screenTools(answer.result) : answer.result });
    if (Buffer.byteLength(out) > MAX_BROWSER_MESSAGE) {
      const mb = Math.round(Buffer.byteLength(out) / 1024 / 1024);
      log.warn("ai-browser", "answer too large", { tool, mb });
      const text = `The answer is too large (${mb} MB, at most ${MAX_BROWSER_MESSAGE / 1024 / 1024} MB): take a screenshot of the visible part, or a snapshot of one element`;
      out = JSON.stringify({ jsonrpc: "2.0", id: r.id, result: { content: [{ type: "text", text }], isError: true } });
    }
    if (this.socket === s && s.readyState === 1) s.send(out);
  }

  private send(s: LinkSocket, msg: object) {
    if (s.readyState === 1) s.send(JSON.stringify(msg));
  }
}
