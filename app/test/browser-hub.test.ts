// The hub of the relay browsers (src/server/browser-hub.ts) on an HTTP server of this process, with relays played by
// websocket clients: who may open a socket, the list of tools it keeps, one call at a time per account, the limit of a
// call, and the handle the /mcp route reaches through globalThis.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { browserHub } from "@/lib/browser-hub";
import { attachBrowserHub } from "@/server/browser-hub";
import { RELAY_BROWSER_PATH } from "@/shared/relay-sync";

let server: http.Server;
let url: string;
let hub: ReturnType<typeof attachBrowserHub>;

type Rpc = { jsonrpc: "2.0"; id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
type FakeRelay = { ws: WebSocket; got: Rpc[]; closed: Promise<number> };

const TOOLS = [{ name: "browser_navigate", description: "Navigate", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }];

// A relay: answers tools/list with TOOLS, and each call as `answer` says (null: no answer)
function relay(token: string, answer: (r: Rpc) => unknown = (r) => ({ content: [{ type: "text", text: `ran ${r.params?.name}` }] })): Promise<FakeRelay> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}${RELAY_BROWSER_PATH}`, { headers: { authorization: `Bearer ${token}` } });
    const got: Rpc[] = [];
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    ws.on("message", (data) => {
      const r = JSON.parse(String(data)) as Rpc;
      got.push(r);
      const result = r.method === "tools/list" ? { tools: TOOLS } : answer(r);
      if (result instanceof Promise) void result.then((v) => v !== null && ws.send(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: v })));
      else if (result !== null) ws.send(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }));
    });
    ws.on("open", () => resolve({ ws, got, closed }));
    ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(check: () => T, what: string, timeout = 5_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = check();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
}

beforeAll(async () => {
  server = http.createServer((_req, res) => res.writeHead(404).end());
  hub = attachBrowserHub(server, {
    // the relay of account 1 by "one", of account 2 by "two"; nobody else
    check: async (req) => ({ "Bearer one": 1, "Bearer two": 2 })[req.headers.authorization ?? ""] ?? null,
    callTimeoutMs: 300,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  hub.close();
  server.close();
});

describe("relay sockets", () => {
  it("refuses a socket the web app does not know: 403, nothing kept", async () => {
    await expect(relay("nobody")).rejects.toThrow("HTTP 403");
    expect(browserHub()?.tools(3)).toBeNull();
  });

  it("leaves other paths to the other listeners", async () => {
    const ws = new WebSocket(`${url}/api/call/audio/socket`, { headers: { authorization: "Bearer one" } });
    const outcome = await new Promise<string>((r) => {
      ws.on("open", () => r("open"));
      ws.on("error", () => r("error"));
      ws.on("unexpected-response", () => r("refused"));
      setTimeout(() => r("left alone"), 300);
    });
    ws.terminate();
    expect(outcome).toBe("left alone");
  });

  it("asks the relay for its tools at once and keeps them for the route", async () => {
    const r = await relay("one");
    await until(() => browserHub()?.tools(1), "tools of account 1");
    expect(r.got[0]).toMatchObject({ method: "tools/list" });
    expect(browserHub()?.tools(1)).toEqual(TOOLS);
    r.ws.close();
    await until(() => browserHub()?.tools(1) === null, "tools gone with the socket");
  });

  it("forwards a call and gives its answer as it came, images included", async () => {
    const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
    const r = await relay("one", () => ({ content: [{ type: "text", text: "ok" }, image] }));
    await until(() => browserHub()?.tools(1), "tools");
    const answer = await browserHub()!.call(1, "browser_take_screenshot", { scale: "css" });
    expect(answer).toEqual({ content: [{ type: "text", text: "ok" }, image] });
    expect(r.got[1]).toMatchObject({ method: "tools/call", params: { name: "browser_take_screenshot", arguments: { scale: "css" } } });
    r.ws.close();
  });

  it("answers a tool error naming the account when its relay has no socket", async () => {
    const answer = await browserHub()!.call(4, "browser_snapshot", {});
    expect(answer).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/account 4/) }] });
  });

  it("lets a newer socket of the same account replace the older; a call waiting on the older ends in an error", async () => {
    const old = await relay("two", () => null);
    await until(() => browserHub()?.tools(2), "tools of the old socket");
    const waiting = browserHub()!.call(2, "browser_snapshot", {});
    await until(() => old.got.length === 2, "call sent to the old socket");
    const fresh = await relay("two");
    expect(await old.closed).toBeGreaterThan(0);
    expect(await waiting).toMatchObject({ isError: true });
    await until(() => fresh.got.length >= 1, "tools asked of the new socket");
    expect(await browserHub()!.call(2, "browser_snapshot", {})).toEqual({ content: [{ type: "text", text: "ran browser_snapshot" }] });
    fresh.ws.close();
  });

  it("sends one call at a time per account, in order", async () => {
    let inFlight = 0;
    let most = 0;
    const r = await relay("one", async () => {
      most = Math.max(most, ++inFlight);
      await sleep(40);
      inFlight--;
      return { content: [] };
    });
    await until(() => browserHub()?.tools(1), "tools");
    await Promise.all([1, 2, 3].map((i) => browserHub()!.call(1, `browser_click`, { target: `e${i}` })));
    expect(most).toBe(1);
    expect(r.got.slice(1).map((m) => m.params?.arguments?.target)).toEqual(["e1", "e2", "e3"]);
    r.ws.close();
  });

  it("gives up a call after its limit with a tool error, and the next call goes", async () => {
    let n = 0;
    const r = await relay("one", () => (++n === 1 ? null : { content: [{ type: "text", text: "second" }] }));
    await until(() => browserHub()?.tools(1), "tools");
    const started = Date.now();
    expect(await browserHub()!.call(1, "browser_wait_for", { time: 60 })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/No answer/) }] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(await browserHub()!.call(1, "browser_snapshot", {})).toEqual({ content: [{ type: "text", text: "second" }] });
    r.ws.close();
  });

  it("answers an error of the relay as a tool error with its message", async () => {
    const ws = await new Promise<WebSocket>((resolve) => {
      const s = new WebSocket(`${url}${RELAY_BROWSER_PATH}`, { headers: { authorization: "Bearer one" } });
      s.on("message", (data) => {
        const m = JSON.parse(String(data)) as Rpc;
        s.send(JSON.stringify(m.method === "tools/list" ? { jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } } : { jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "browser crashed" } }));
      });
      s.on("open", () => resolve(s));
    });
    await until(() => browserHub()?.tools(1), "tools");
    expect(await browserHub()!.call(1, "browser_snapshot", {})).toEqual({ content: [{ type: "text", text: "browser crashed" }], isError: true });
    ws.close();
  });
});
