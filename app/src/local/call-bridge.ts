import type { BrowserContext } from "playwright-core";
import { Agent } from "undici";
import { errorText, log } from "@/agent/log";
import { CALL_AUDIO_PATH } from "@/shared/relay-sync";
import { installCallBridge } from "./call-bridge-page";
import { openLink, type LinkSocket, type OpenSocket } from "./link-socket";

// The sound of a call answered or placed from the app on this account, in the app: the relay side of the bridge. The
// page (call-bridge-page.ts) asks here when Teams wants the microphone; the call is the app's when the app armed the
// bridge shortly before (an answer or a call command with its sound in the app). Then the sound Teams receives goes to
// the server as Opus packets, and the app's microphone comes back from it, over one websocket the relay opens to the
// server (/api/call/audio/socket, src/server/call-audio-hub.ts). A call answered in the Teams window of this computer
// is never the app's: Teams gets the microphone of the computer, and nothing leaves.

export const BRIDGE_BINDING = "__teamsRelayCallBridge";

// an arm with no microphone asked for within this long is dropped: that answer or call did not happen
const ARM_MS = 90_000;
// a pull of the page waits this long for a packet of the app, then answers with none
const PULL_WAIT_MS = 1_000;
// packets of the app the page did not take yet: beyond this many the oldest go (the page fell behind)
const QUEUE_MAX = 25;
// a socket lost during a call opens again after this long
const RECONNECT_MS = 1_000;

type Msg = { op?: unknown; p?: unknown; channels?: unknown; host?: unknown };

export type CallBridgeOptions = {
  // the server the relay joined, and its token
  url: string;
  token: string;
  open?: OpenSocket;
  clock?: () => number;
};

export class CallBridge {
  private armedAt = 0;
  private active = false;
  private socket: LinkSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private queue: Uint8Array[] = [];
  private waiting: (() => void) | null = null;
  private channels = 0;
  private stopped = false;
  // the sites whose pages have the hook, logged once each
  private readonly hooked = new Set<string>();
  // packets of the call now: sent to the app, and taken from it by the page
  private counts = { down: 0, up: 0 };
  private readonly agent = new Agent({ allowH2: false });

  constructor(private readonly o: CallBridgeOptions) {}

  // The binding and the page script in every frame of the browser, before Teams loads; the frames already there get
  // the script now (Teams asks for the microphone only when a call starts)
  async attach(context: BrowserContext) {
    await context.exposeBinding(BRIDGE_BINDING, (_source, m: Msg) => this.fromPage(m));
    await context.addInitScript(installCallBridge, BRIDGE_BINDING);
    let installed = 0;
    for (const page of context.pages()) {
      for (const frame of page.frames()) if ((await frame.evaluate(installCallBridge, BRIDGE_BINDING).catch(() => "failed")) === "installed") installed++;
    }
    if (installed) log.info("bridge", "call sound hook installed", { frames: installed });
  }

  // An answer or a call placed from the app, with its sound in the app: the next microphone Teams asks for is the app's.
  // The socket opens now, so the app hears the call from its first moment.
  arm() {
    if (this.stopped) return;
    const at = (this.armedAt = this.now());
    log.info("bridge", "armed: the next call goes to the app");
    this.connect();
    setTimeout(() => {
      if (this.armedAt === at && !this.active) this.finish(null);
    }, ARM_MS).unref?.();
  }

  // whether the sound of a call goes to the app now
  get live() {
    return this.active;
  }

  stop() {
    this.stopped = true;
    this.finish(null);
    void this.agent.close().catch(() => undefined);
  }

  private now() {
    return (this.o.clock ?? Date.now)();
  }

  // What the page says: Teams wants the microphone, a packet of the sound received, the format of that sound, a pull of
  // the app's packets, the end of the call
  private async fromPage(m: Msg): Promise<unknown> {
    switch (m.op) {
      case "ready":
        if (typeof m.host === "string" && !this.hooked.has(m.host)) {
          this.hooked.add(m.host);
          log.info("bridge", "call sound hook in the page", { site: m.host });
        }
        return null;
      case "mic": {
        const armed = this.armedAt && this.now() - this.armedAt <= ARM_MS;
        if (this.active || !armed) return { bridge: false };
        this.armedAt = 0;
        this.active = true;
        this.queue = [];
        this.counts = { down: 0, up: 0 };
        this.connect();
        this.text("CAPTURE_DEMAND microphone 1");
        log.info("bridge", "call in progress: its sound goes to the app");
        return { bridge: true };
      }
      case "down":
        if (this.active && typeof m.p === "string") {
          this.send(new Uint8Array(Buffer.from(m.p, "base64")));
          this.counts.down++;
        }
        return null;
      case "format":
        if (typeof m.channels === "number" && m.channels !== this.channels) {
          this.channels = m.channels;
          this.text(`CHANNELS ${m.channels}`);
        }
        return null;
      case "pull":
        return this.pull();
      case "end":
        if (this.active) this.finish("the call ended in Teams");
        return null;
    }
    return null;
  }

  private async pull(): Promise<{ p?: string[]; end?: boolean }> {
    if (!this.active) return { end: true };
    if (!this.queue.length) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, PULL_WAIT_MS);
        const prev = this.waiting;
        function done() {
          clearTimeout(t);
          resolve();
        }
        this.waiting = () => {
          prev?.();
          done();
        };
      });
    }
    if (!this.active) return { end: true };
    const p = this.queue.map((b) => Buffer.from(b).toString("base64"));
    this.queue = [];
    this.counts.up += p.length;
    return { p };
  }

  private fromServer(data: unknown) {
    if (typeof data === "string" || !this.active) return;
    const frame = new Uint8Array(data as ArrayBuffer);
    // 0x02: one Opus packet of the app's microphone
    if (frame.length < 2 || frame[0] !== 0x02) return;
    this.queue.push(frame.slice(1));
    if (this.queue.length > QUEUE_MAX) this.queue.splice(0, this.queue.length - QUEUE_MAX);
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  private connect() {
    if (this.socket || this.stopped) return;
    try {
      this.socket = openLink(
        { server: this.o.url, path: CALL_AUDIO_PATH, token: this.o.token, dispatcher: this.agent, open: this.o.open, current: () => this.socket },
        {
          open: () => {
            log.info("bridge", "socket to the server open");
            if (this.channels) this.text(`CHANNELS ${this.channels}`);
            if (this.active) this.text("CAPTURE_DEMAND microphone 1");
          },
          message: (_s, data) => this.fromServer(data),
          close: () => {
            this.socket = null;
            // a call in progress, or one armed: the socket opens again
            if (!this.stopped && (this.active || this.armedAt)) {
              this.retry = setTimeout(() => {
                this.retry = null;
                this.connect();
              }, RECONNECT_MS);
            }
          },
        },
      );
      this.socket.binaryType = "arraybuffer";
    } catch (e) {
      log.warn("bridge", `socket: ${errorText(e)}`);
    }
  }

  private send(b: Uint8Array) {
    if (this.socket?.readyState === 1) this.socket.send(b);
  }

  private text(t: string) {
    if (this.socket?.readyState === 1) this.socket.send(t);
  }

  private finish(why: string | null) {
    const was = this.active;
    this.active = false;
    this.armedAt = 0;
    this.queue = [];
    const w = this.waiting;
    this.waiting = null;
    w?.();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      if (was && s.readyState === 1) s.send("CAPTURE_DEMAND microphone 0");
      s.close();
    }
    if (was && why) log.info("bridge", `call sound in the app over: ${why}`, { sent: this.counts.down, received: this.counts.up });
  }
}
