// The socket of the sound of a call of an account on another computer (src/server/call-audio-hub.ts), on an HTTP server
// of this process, with the page of the app and the relay played by websocket clients: who may open which side, what
// goes from one to the other, and what the page is told when the relay is not there or leaves.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { attachCallAudioHub } from "@/server/call-audio-hub";
import { CALL_AUDIO_PATH } from "@/shared/relay-sync";

let server: http.Server;
let url: string;
let hub: ReturnType<typeof attachCallAudioHub>;
// Next.js' own listener of the upgrades, which leaves alone a path of no page or route
let othersSawIt = 0;

type Client = { ws: WebSocket; got: (string | Buffer)[]; closed: Promise<number> };

function open(query: string, headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}${CALL_AUDIO_PATH}${query}`, { headers });
    const got: (string | Buffer)[] = [];
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    ws.on("message", (data, binary) => got.push(binary ? (data as Buffer) : String(data)));
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
    await sleep(20);
  }
}
const texts = (c: Client) => c.got.filter((m): m is string => typeof m === "string");
const frames = (c: Client) => c.got.filter((m): m is Buffer => typeof m !== "string");

beforeAll(async () => {
  server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", () => othersSawIt++);
  hub = attachCallAudioHub(server, {
    // the relay of account 1 by its token, the page of the app by ?a=1; nobody else
    check: async (req) => {
      if (req.headers.authorization === "Bearer good") return { slot: 1, side: "relay" };
      return new URL(req.url ?? "/", "http://x").searchParams.get("a") === "1" && req.headers.cookie === "s=1" ? { slot: 1, side: "app" } : null;
    },
    relayWaitMs: 500,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  hub.close();
  server.close();
});

describe("the socket of the sound of a call of an account on another computer", () => {
  it("refuses whoever the web app does not name: 403", async () => {
    await expect(open("?a=1")).rejects.toThrow("HTTP 403");
    await expect(open("", { authorization: "Bearer bad" })).rejects.toThrow("HTTP 403");
  });

  it("tells the page the relay sends no sound when it is not there in time, and closes", async () => {
    const app = await open("?a=1", { cookie: "s=1" });
    expect(await app.closed).toBe(1005);
    expect(texts(app).at(-1)).toBe("UNAVAILABLE The relay of the account sends no sound");
  });

  it("carries the sound both ways, the demand for the microphone, and its end when the relay leaves", async () => {
    const app = await open("?a=1", { cookie: "s=1" });
    app.ws.send("START_AUDIO");
    const relay = await open("", { authorization: "Bearer good" });
    await until(() => texts(app).includes("AUDIO_STARTED"), "AUDIO_STARTED");

    relay.ws.send("CHANNELS 1");
    relay.ws.send("CAPTURE_DEMAND microphone 1");
    relay.ws.send(Buffer.from([0xfc, 0xff, 0xfe]));
    await until(() => frames(app).length === 1, "a frame of sound");
    // one Opus packet in a 0x01 frame, no redundant block, as the player of the app reads it
    expect([...frames(app)[0]]).toEqual([0x01, 0x00, 0xfc, 0xff, 0xfe]);
    expect(texts(app)).toContain("CAPTURE_DEMAND microphone 1");
    expect(texts(app).map((t) => (t.startsWith("{") ? JSON.parse(t) : t))).toContainEqual({ type: "server_settings", settings: { audio_channels: { value: 1 } } });

    app.ws.send(Buffer.from([0x02, 0x11, 0x22]));
    await until(() => frames(relay).length === 1, "a frame of the microphone");
    expect([...frames(relay)[0]]).toEqual([0x02, 0x11, 0x22]);

    relay.ws.close();
    await until(() => texts(app).includes("CAPTURE_DEMAND microphone 0"), "demand over");
    // a relay back in time: the sound goes on
    const again = await open("", { authorization: "Bearer good" });
    await until(() => texts(app).filter((t) => t === "AUDIO_STARTED").length === 2, "AUDIO_STARTED again");
    await sleep(700);
    expect(app.ws.readyState).toBe(WebSocket.OPEN);
    app.ws.close();
    again.ws.close();
    await until(() => !hub.pairs.has(1), "nothing left of the call");
    expect(othersSawIt).toBeGreaterThan(0);
  });
});
