import type http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { BROWSER_HUB_KEY, type BrowserHub, type BrowserTool, type ToolResult } from "@/lib/browser-hub";
import { MAX_BROWSER_MESSAGE, RELAY_BROWSER_PATH } from "@/shared/relay-sync";

// The browsers of the relays for the MCP clients (docs/design/2026-10-01-relay-browser-mcp.md): the relay of an account
// on another computer with RELAY_BROWSER=1 opens a websocket here, on the port of the web app (loaded before Next.js
// with the call-audio hub, src/server/call-audio-preload.ts). The hub asks it for its tools at once and keeps them; the
// /mcp route sends calls through the handle on globalThis (src/lib/browser-hub.ts), one at a time per account, each
// with a limit. Requests and answers are JSON-RPC; the relay checks every request against its allowlist. Who may open
// the socket of which account is the web app's to say (GET /api/relay/browser): the token of the relay.

// a call of a tool with no answer by then is given up: a page that never loads, a relay gone silent
export const CALL_LIMIT_MS = 90_000;

// The account of a request, null when it may open none
export type Check = (req: http.IncomingMessage) => Promise<number | null>;

type Reply = { result?: unknown; error?: { message?: unknown } };
type Relay = { ws: WebSocket; tools: BrowserTool[] | null; pending: Map<number, (r: Reply) => void>; queue: Promise<unknown> };

const toolError = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

// The web app answers whose relay the request is: its Authorization header goes to GET /api/relay/browser on this
// same server
export function webAppCheck(server: http.Server): Check {
  return async (req) => {
    const address = server.address();
    if (!address || typeof address === "string") return null;
    const host = address.address === "0.0.0.0" || address.address === "::" ? "127.0.0.1" : address.address;
    const auth = req.headers.authorization;
    if (typeof auth !== "string") return null;
    const r = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${address.port}/api/relay/browser`, {
      headers: { authorization: auth },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const b = (await r.json()) as { slot?: unknown };
    return Number.isInteger(b.slot) ? (b.slot as number) : null;
  };
}

export function attachBrowserHub(server: http.Server, o: { check?: Check; callTimeoutMs?: number } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BROWSER_MESSAGE });
  const relays = new Map<number, Relay>();
  const check = o.check ?? webAppCheck(server);
  const limit = o.callTimeoutMs ?? CALL_LIMIT_MS;
  let nextId = 1;

  // one request to the relay, answered by its reply, or by an error at the limit or when the socket goes
  function request(r: Relay, method: string, params: unknown): Promise<Reply> {
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        r.pending.delete(id);
        resolve({ error: { message: `No answer from the relay within ${Math.round(limit / 1000)} s` } });
      }, limit);
      r.pending.set(id, (reply) => {
        clearTimeout(timer);
        r.pending.delete(id);
        resolve(reply);
      });
      if (r.ws.readyState === 1) r.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  // after the calls already waiting for this account
  function queued<T>(r: Relay, run: () => Promise<T>): Promise<T> {
    const next = r.queue.then(run, run);
    r.queue = next.catch(() => undefined);
    return next;
  }

  function fail(r: Relay, why: string) {
    for (const done of [...r.pending.values()]) done({ error: { message: why } });
  }

  function join(slot: number, ws: WebSocket) {
    const r: Relay = { ws, tools: null, pending: new Map(), queue: Promise.resolve() };
    const old = relays.get(slot);
    relays.set(slot, r);
    if (old) {
      fail(old, "The relay of the account connected again: call it again");
      old.ws.close();
    }
    ws.on("message", (data) => {
      let m: { id?: unknown; result?: unknown; error?: { message?: unknown } };
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof m.id === "number") r.pending.get(m.id)?.({ result: m.result, error: m.error });
    });
    ws.on("close", () => {
      fail(r, `The relay of account ${slot} left`);
      if (relays.get(slot) === r) relays.delete(slot);
    });
    void queued(r, async () => {
      const reply = await request(r, "tools/list", {});
      const tools = (reply.result as { tools?: unknown } | undefined)?.tools;
      if (Array.isArray(tools)) r.tools = tools as BrowserTool[];
    });
  }

  const hub: BrowserHub = {
    tools: (slot) => relays.get(slot)?.tools ?? null,
    call: (slot, name, args) => {
      const r = relays.get(slot);
      if (!r) return Promise.resolve(toolError(`The relay of account ${slot} is not connected, or runs without RELAY_BROWSER=1`));
      return queued(r, async () => {
        const reply = await request(r, "tools/call", { name, arguments: args });
        if (reply.error) return toolError(String(reply.error.message ?? "The relay could not run the tool"));
        const result = reply.result as ToolResult | undefined;
        return result && Array.isArray(result.content) ? result : toolError("The relay answered nothing usable");
      });
    },
  };
  (globalThis as Record<string, unknown>)[BROWSER_HUB_KEY] = hub;

  server.on("upgrade", (req: http.IncomingMessage, socket, head: Buffer) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== RELAY_BROWSER_PATH) return;
    socket.on("error", () => undefined);
    check(req).then(
      (slot) => {
        if (slot === null) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => join(slot, ws));
      },
      () => socket.destroy(),
    );
  });

  return {
    close: () => {
      wss.close();
      if ((globalThis as Record<string, unknown>)[BROWSER_HUB_KEY] === hub) delete (globalThis as Record<string, unknown>)[BROWSER_HUB_KEY];
    },
  };
}
