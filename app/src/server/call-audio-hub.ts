import type http from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { CALL_AUDIO_PATH } from "@/shared/relay-sync";
import { acceptUpgrades, askWebApp } from "./upgrade";

// The sound of a call answered from the app on an account on another computer: the relay of the account and the page
// of the app each open a websocket here, on the port of the web app (Next.js serves no websocket; the process loads this
// before it, src/server/call-audio-preload.ts). The page speaks the audio part of the Selkies protocol it already speaks
// with the remote desktop of the browsers container (src/lib/call-audio/): Opus down in 0x01 frames, the microphone up
// as 0x02 frames while the server asks for it (CAPTURE_DEMAND). The relay sends bare Opus packets and the demand, and
// gets the 0x02 frames as they come. One call per account: a newer socket of the same side replaces the older one.
// Who may open which side is the web app's to say (GET /api/call/audio): the session of the page, the token of the relay.

// the page waits this long for the relay of the account to be there, at the start and after the relay left
const RELAY_WAIT_MS = 20_000;
// the largest message taken: a packet of Opus is a few hundred bytes
const MAX_PAYLOAD = 64 * 1024;

type Side = { slot: number; side: "app" | "relay" };
// The side a request may open, null when it may open none
export type Check = (req: http.IncomingMessage) => Promise<Side | null>;

type Pair = { app: WebSocket | null; relay: WebSocket | null; demand: boolean; channels: number; wait: ReturnType<typeof setTimeout> | null };

const settings = (channels: number) => JSON.stringify({ type: "server_settings", settings: { audio_channels: { value: channels } } });

// The web app answers who the request is: the headers that carry the session or the token, and the origin, go to
// GET /api/call/audio on this same server
function webAppCheck(server: http.Server): Check {
  return async (req) => {
    const q = new URL(req.url ?? "/", "http://x").searchParams.get("a") ?? "";
    const headers: Record<string, string> = {};
    for (const h of ["cookie", "authorization", "origin"]) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    const b = await askWebApp(server, `/api/call/audio${q ? `?a=${encodeURIComponent(q)}` : ""}`, headers);
    return b && Number.isInteger(b.slot) && (b.side === "app" || b.side === "relay") ? { slot: b.slot as number, side: b.side } : null;
  };
}

export function attachCallAudioHub(server: http.Server, o: { check?: Check; relayWaitMs?: number } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const pairs = new Map<number, Pair>();
  const check = o.check ?? webAppCheck(server);
  const relayWait = o.relayWaitMs ?? RELAY_WAIT_MS;

  const pairOf = (slot: number) => {
    let p = pairs.get(slot);
    if (!p) pairs.set(slot, (p = { app: null, relay: null, demand: false, channels: 1, wait: null }));
    return p;
  };
  const toApp = (p: Pair, data: string | Buffer) => {
    if (p.app?.readyState === 1) p.app.send(data);
  };
  // the page waits for the relay; with none by then it says so, and the page gives the sound in the app up
  const waitForRelay = (p: Pair) => {
    if (p.wait || !p.app) return;
    p.wait = setTimeout(() => {
      p.wait = null;
      if (p.relay || !p.app) return;
      toApp(p, "UNAVAILABLE The relay of the account sends no sound");
      p.app.close();
    }, relayWait);
  };
  const settle = (slot: number, p: Pair) => {
    if (!p.app && !p.relay) {
      if (p.wait) clearTimeout(p.wait);
      pairs.delete(slot);
    }
  };

  function joinApp(slot: number, ws: WebSocket) {
    const p = pairOf(slot);
    const old = p.app;
    p.app = ws;
    old?.close();
    toApp(p, settings(p.channels));
    if (p.relay) {
      toApp(p, "AUDIO_STARTED");
      if (p.demand) toApp(p, "CAPTURE_DEMAND microphone 1");
    } else waitForRelay(p);
    ws.on("message", (data: RawData, binary: boolean) => {
      if (p.app !== ws) return;
      if (!binary) {
        if (String(data).startsWith("START_AUDIO") && p.relay) toApp(p, "AUDIO_STARTED");
        return;
      }
      const b = data as Buffer;
      if (b[0] === 0x02 && p.relay?.readyState === 1) p.relay.send(b);
    });
    ws.on("close", () => {
      if (p.app !== ws) return;
      p.app = null;
      if (p.wait) clearTimeout(p.wait);
      p.wait = null;
      settle(slot, p);
    });
  }

  function joinRelay(slot: number, ws: WebSocket) {
    const p = pairOf(slot);
    const old = p.relay;
    p.relay = ws;
    old?.close();
    if (p.wait) clearTimeout(p.wait);
    p.wait = null;
    toApp(p, "AUDIO_STARTED");
    ws.on("message", (data: RawData, binary: boolean) => {
      if (p.relay !== ws) return;
      if (binary) {
        // one Opus packet of the sound of the call: a 0x01 frame with no redundant block
        toApp(p, Buffer.concat([Buffer.from([0x01, 0x00]), data as Buffer]));
        return;
      }
      const t = String(data);
      const demand = /^CAPTURE_DEMAND microphone ([01])$/.exec(t);
      if (demand) {
        p.demand = demand[1] === "1";
        toApp(p, t);
        return;
      }
      const channels = /^CHANNELS ([12])$/.exec(t);
      if (channels) {
        p.channels = Number(channels[1]);
        toApp(p, settings(p.channels));
      }
    });
    ws.on("close", () => {
      if (p.relay !== ws) return;
      p.relay = null;
      if (p.demand) toApp(p, "CAPTURE_DEMAND microphone 0");
      p.demand = false;
      waitForRelay(p);
      settle(slot, p);
    });
  }

  acceptUpgrades(server, wss, CALL_AUDIO_PATH, check, (who, ws) => (who.side === "app" ? joinApp(who.slot, ws) : joinRelay(who.slot, ws)));
  return { close: () => wss.close(), pairs };
}
