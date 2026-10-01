import { audioChannels, captureDemand, OP, opusPacket } from "./frames";

// What the link needs of a WebSocket (the browser's, or a fake in the tests)
export type SocketLike = {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBufferView): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

// connecting and retrying until the sound flows (live); desktop: a page of the remote desktop took the stream over;
// unavailable: the server refuses or cannot be reached; closed: stopped here
export type LinkState = "connecting" | "live" | "retrying" | "desktop" | "unavailable" | "closed";

export type AudioLinkEvents = {
  audio(packet: Uint8Array): void;
  channels(n: number): void;
  mic(wanted: boolean): void;
  micDisabled(): void;
  state(s: LinkState, reason?: string): void;
};

// Selkies starts the audio for START_AUDIO only once a page has sent SETTINGS since it started: with nothing flowing
// after this long, one SETTINGS for the primary display, with no size so the desktop keeps its own
const START_FALLBACK_MS = 3_000;
// Selkies closes a second connection from one address within 500 ms with this code; every page comes through Caddy
const TOO_SOON = 4029;
const TOO_SOON_RETRIES = 3;
const TOO_SOON_WAIT_MS = 1_000;
// a lost connection: again after 1, 2, 4, 8, 16 s
const LOST_RETRIES = 5;

async function inflate(data: Uint8Array): Promise<string> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

// The audio of the remote desktop over the websocket of Selkies, without its video: Opus down, the microphone up while
// the server asks for it (a program on the desktop, Teams in a call, records from the virtual microphone)
export class AudioLink {
  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flowing = false;
  private micWanted = false;
  private tooSoon = 0;
  private lost = 0;
  private over = false;
  private state: LinkState | null = null;
  private reason: string | undefined;

  constructor(private readonly o: { url: string; open: (url: string) => SocketLike; events: AudioLinkEvents }) {}

  start() {
    this.set("connecting");
    this.connect();
  }

  sendMic(frame: Uint8Array) {
    if (this.socket?.readyState === 1) this.socket.send(frame);
  }

  stop() {
    if (this.state !== "closed") this.end("closed");
  }

  private connect() {
    const s = this.o.open(this.o.url);
    this.socket = s;
    this.flowing = false;
    s.binaryType = "arraybuffer";
    s.onopen = () => {
      if (this.socket !== s) return;
      s.send("START_AUDIO");
      this.arm(START_FALLBACK_MS, () => {
        if (this.socket !== s || this.flowing) return;
        s.send('SETTINGS,{"displayId":"primary"}');
        s.send("START_AUDIO");
      });
    };
    s.onmessage = (ev) => {
      if (this.socket === s) this.message(s, ev.data);
    };
    s.onclose = (ev) => {
      if (this.socket === s) this.closed(ev.code);
    };
    s.onerror = () => undefined;
  }

  private message(s: SocketLike, data: unknown) {
    if (typeof data === "string") return this.text(data);
    const frame = new Uint8Array(data as ArrayBuffer);
    if (frame[0] === OP.audio) {
      const packet = opusPacket(frame);
      if (!packet) return;
      this.live();
      this.o.events.audio(packet);
    } else if (frame[0] === OP.gzipText) {
      // large control text comes gzip-wrapped
      void inflate(frame.subarray(1)).then(
        (t) => this.socket === s && this.text(t),
        () => undefined,
      );
    }
  }

  private text(t: string) {
    if (t === "AUDIO_STARTED") return this.live();
    if (t === "AUDIO_DISABLED") return this.end("unavailable", "The remote desktop plays no sound");
    // the server of the sound of a call of an account on another computer: no sound will come (src/server/call-audio-hub.ts)
    if (t.startsWith("UNAVAILABLE")) return this.end("unavailable", t.slice(12) || undefined);
    if (t === "MICROPHONE_DISABLED") return this.o.events.micDisabled();
    // a page of the desktop took the primary display, and the sound with it
    if (t.startsWith("KILL")) return this.end("desktop");
    const demand = captureDemand(t);
    if (demand) {
      if (demand.subject === "microphone") this.mic(demand.wanted);
      return;
    }
    if (t.startsWith("{")) {
      try {
        const m = JSON.parse(t) as { type?: string };
        if (m.type === "server_settings") this.o.events.channels(audioChannels(m));
      } catch {
        // not JSON after all
      }
    }
  }

  private live() {
    if (this.flowing) return;
    this.flowing = true;
    this.tooSoon = 0;
    this.lost = 0;
    this.disarm();
    this.set("live");
  }

  private mic(wanted: boolean) {
    if (wanted === this.micWanted) return;
    this.micWanted = wanted;
    this.o.events.mic(wanted);
  }

  private closed(code: number) {
    this.socket = null;
    this.disarm();
    this.mic(false);
    if (this.over) return;
    if (code === TOO_SOON && this.tooSoon < TOO_SOON_RETRIES) {
      this.tooSoon++;
      this.again(TOO_SOON_WAIT_MS);
    } else if (code !== TOO_SOON && this.lost < LOST_RETRIES) {
      this.again(1_000 * 2 ** this.lost++);
    } else {
      this.over = true;
      this.set("unavailable", code === TOO_SOON ? "The remote desktop is busy" : "The remote desktop cannot be reached");
    }
  }

  private again(ms: number) {
    this.set("retrying");
    this.arm(ms, () => this.connect());
  }

  private end(state: LinkState, reason?: string) {
    this.over = true;
    this.disarm();
    this.mic(false);
    const s = this.socket;
    this.socket = null;
    s?.close();
    this.set(state, reason);
  }

  private arm(ms: number, fn: () => void) {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  private disarm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private set(state: LinkState, reason?: string) {
    if (state === this.state && reason === this.reason) return;
    this.state = state;
    this.reason = reason;
    this.o.events.state(state, reason);
  }
}
