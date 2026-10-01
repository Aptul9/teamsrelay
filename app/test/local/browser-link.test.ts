// The socket of the relay browser to the server, with a fake socket and a fake host: what the allowlist refuses never
// reaches Playwright MCP, answers go back with their id, one call at a time, and a dropped socket opens again.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserLink, type LinkSocket } from "@/local/browser-link";
import { MAX_BROWSER_MESSAGE, RELAY_BROWSER_PATH } from "@/shared/relay-sync";

class FakeSocket implements LinkSocket {
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly token: string,
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
}

type Call = { method: string; params: Record<string, unknown> };

function fakeHost(answer: (c: Call) => Promise<{ result?: unknown; error?: unknown }> = async (c) => ({ result: { content: [{ type: "text", text: `ran ${String(c.params.name)}` }] } })) {
  const calls: Call[] = [];
  let closed = 0;
  return {
    calls,
    closed: () => closed,
    host: {
      async request(method: "tools/list" | "tools/call", params: Record<string, unknown>) {
        calls.push({ method, params });
        return answer({ method, params });
      },
      async close() {
        closed++;
      },
    },
  };
}

const links: BrowserLink[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const l of links.splice(0)) await l.stop();
});

function link(host: ReturnType<typeof fakeHost>["host"]) {
  const sockets: FakeSocket[] = [];
  const l = new BrowserLink({
    url: "https://teams.example.com",
    token: "t0ken",
    host,
    open: (url, token) => {
      const s = new FakeSocket(url, token);
      sockets.push(s);
      return s;
    },
  });
  links.push(l);
  l.start();
  return { l, sockets };
}

const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("the socket to the server", () => {
  it("opens wss://<server>/api/relay/browser/socket with the token of the relay", () => {
    const { sockets } = link(fakeHost().host);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe(`wss://teams.example.com${RELAY_BROWSER_PATH}`);
    expect(sockets[0].token).toBe("t0ken");
  });

  it("answers what the allowlist refuses itself: nothing of it reaches Playwright MCP", async () => {
    const fake = fakeHost();
    const { sockets } = link(fake.host);
    const s = sockets[0];
    s.open();
    s.receive(call(1, "browser_run_code_unsafe", { code: "require('child_process').exec('calc')" }));
    s.receive(call(2, "browser_evaluate", { function: "() => document.cookie" }));
    s.receive(call(3, "browser_take_screenshot", { filename: "C:/Windows/x.png" }));
    s.receive(call(4, "browser_navigate", { url: "file:///C:/Users" }));
    s.receive({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} });
    s.receive("not json");
    s.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
    await settle();
    expect(fake.calls).toEqual([]);
    expect(s.sent.map((m) => (m as { id: number }).id)).toEqual([1, 2, 3, 4, 5]);
    expect(s.sent[0]).toMatchObject({ id: 1, result: { isError: true } });
    expect(s.sent[4]).toMatchObject({ id: 5, error: { code: -32601 } });
  });

  it("sends an allowed call to Playwright MCP and its answer back with the same id", async () => {
    const fake = fakeHost();
    const { sockets } = link(fake.host);
    const s = sockets[0];
    s.open();
    s.receive(call(9, "browser_navigate", { url: "https://www.wikipedia.org/" }));
    await settle();
    expect(fake.calls).toEqual([{ method: "tools/call", params: { name: "browser_navigate", arguments: { url: "https://www.wikipedia.org/" } } }]);
    expect(s.sent).toEqual([{ jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text: "ran browser_navigate" }] } }]);
  });

  it("shows the server the allowed tools only, without filename", async () => {
    const fake = fakeHost(async () => ({
      result: {
        tools: [
          { name: "browser_navigate", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
          { name: "browser_run_code_unsafe", inputSchema: { type: "object" } },
          { name: "browser_snapshot", inputSchema: { type: "object", properties: { filename: { type: "string" } } } },
        ],
      },
    }));
    const { sockets } = link(fake.host);
    sockets[0].open();
    sockets[0].receive({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await settle();
    expect(sockets[0].sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            { name: "browser_navigate", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
            { name: "browser_snapshot", inputSchema: { type: "object", properties: {} } },
          ],
        },
      },
    ]);
  });

  it("answers a tool error instead of an answer larger than the socket takes", async () => {
    const big = "x".repeat(MAX_BROWSER_MESSAGE);
    const fake = fakeHost(async () => ({ result: { content: [{ type: "image", data: big, mimeType: "image/png" }] } }));
    const { sockets } = link(fake.host);
    sockets[0].open();
    sockets[0].receive(call(3, "browser_take_screenshot", { fullPage: true }));
    await settle();
    expect(sockets[0].sent).toHaveLength(1);
    expect(sockets[0].sent[0]).toMatchObject({ id: 3, result: { isError: true, content: [{ type: "text", text: expect.stringMatching(/too large/) }] } });
  });

  it("answers a failure of Playwright MCP as a JSON-RPC error", async () => {
    const fake = fakeHost(async () => {
      throw new Error("browser crashed");
    });
    const { sockets } = link(fake.host);
    sockets[0].open();
    sockets[0].receive(call(4, "browser_snapshot"));
    await settle();
    expect(sockets[0].sent).toEqual([{ jsonrpc: "2.0", id: 4, error: { code: -32603, message: "browser crashed" } }]);
  });

  it("runs the calls one at a time, in the order they came", async () => {
    const order: string[] = [];
    const fake = fakeHost(async (c) => {
      const name = String(c.params.name);
      order.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, name === "browser_wait_for" ? 60 : 1));
      order.push(`end ${name}`);
      return { result: { content: [] } };
    });
    const { sockets } = link(fake.host);
    sockets[0].open();
    sockets[0].receive(call(1, "browser_wait_for", { time: 1 }));
    sockets[0].receive(call(2, "browser_snapshot"));
    await new Promise((r) => setTimeout(r, 120));
    expect(order).toEqual(["start browser_wait_for", "end browser_wait_for", "start browser_snapshot", "end browser_snapshot"]);
  });

  it("opens the socket again after a drop, 1 s, then 2, 4... up to 30 s, and 1 s again after it opened", async () => {
    vi.useFakeTimers();
    const { sockets } = link(fakeHost().host);
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = sockets.length;
      sockets.at(-1)!.close();
      let waited = 0;
      while (sockets.length === before && waited < 60_000) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    sockets.at(-1)!.open();
    sockets.at(-1)!.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(9);
  });

  it("stops: closes the socket and Playwright MCP, opens nothing more", async () => {
    vi.useFakeTimers();
    const fake = fakeHost();
    const { l, sockets } = link(fake.host);
    sockets[0].open();
    await l.stop();
    expect(sockets[0].readyState).toBe(3);
    expect(fake.closed()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });
});
