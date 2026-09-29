// The call audio's side of the Selkies websocket, against a fake socket and a fake clock: the audio is asked for
// without the video, the SETTINGS that starts it on a Selkies no page has talked to comes only when nothing comes,
// the demand for the microphone arrives plain or gzip-wrapped, and a page of the desktop taking over ends it for good.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioLink, type AudioLinkEvents, type LinkState, type SocketLike } from "@/lib/call-audio/socket";

class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(d: string | ArrayBufferView) {
    this.sent.push(typeof d === "string" ? d : new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice());
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // the server side
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  text(t: string) {
    this.onmessage?.({ data: t });
  }
  binary(...b: number[]) {
    this.onmessage?.({ data: new Uint8Array(b).buffer });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

let sockets: FakeSocket[];
let events: { audio: Uint8Array[]; channels: number[]; mic: boolean[]; micDisabled: number; states: [LinkState, string | undefined][] };
let link: AudioLink;

const last = () => sockets[sockets.length - 1];
const texts = () => sockets.flatMap((s) => s.sent.filter((m): m is string => typeof m === "string"));

async function gzip(text: string): Promise<number[]> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return [...new Uint8Array(await new Response(stream).arrayBuffer())];
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  events = { audio: [], channels: [], mic: [], micDisabled: 0, states: [] };
  const handlers: AudioLinkEvents = {
    audio: (p) => events.audio.push(p),
    channels: (n) => events.channels.push(n),
    mic: (w) => events.mic.push(w),
    micDisabled: () => events.micDisabled++,
    state: (s, reason) => events.states.push([s, reason]),
  };
  link = new AudioLink({
    url: "wss://app.test/desktop/api/websockets",
    open: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    events: handlers,
  });
  link.start();
});

afterEach(() => {
  link.stop();
  vi.useRealTimers();
});

describe("AudioLink", () => {
  it("asks for the audio as soon as the socket opens, binary frames as array buffers", () => {
    expect(last().url).toBe("wss://app.test/desktop/api/websockets");
    last().open();
    expect(last().binaryType).toBe("arraybuffer");
    expect(last().sent).toEqual(["START_AUDIO"]);
    expect(events.states.at(-1)).toEqual(["connecting", undefined]);
  });

  it("starts the audio of a Selkies no page has talked to with one SETTINGS for primary, after 3 s of nothing", () => {
    last().open();
    vi.advanceTimersByTime(2_900);
    expect(texts()).toEqual(["START_AUDIO"]);
    vi.advanceTimersByTime(100);
    expect(texts()).toEqual(["START_AUDIO", 'SETTINGS,{"displayId":"primary"}', "START_AUDIO"]);
    vi.advanceTimersByTime(10_000);
    expect(texts()).toHaveLength(3);
  });

  it("sends no SETTINGS once the audio came", () => {
    last().open();
    vi.advanceTimersByTime(1_000);
    last().binary(0x01, 0, 7, 8, 9);
    vi.advanceTimersByTime(10_000);
    expect(texts()).toEqual(["START_AUDIO"]);
    expect(events.audio).toEqual([new Uint8Array([7, 8, 9])]);
    expect(events.states.at(-1)).toEqual(["live", undefined]);
  });

  it("sends no SETTINGS once the server says the audio started", () => {
    last().open();
    last().text("AUDIO_STARTED");
    vi.advanceTimersByTime(10_000);
    expect(texts()).toEqual(["START_AUDIO"]);
    expect(events.states.at(-1)).toEqual(["live", undefined]);
  });

  it("never asks for the video", () => {
    last().open();
    vi.advanceTimersByTime(3_000);
    last().drop(1006);
    vi.advanceTimersByTime(1_000);
    last().open();
    vi.advanceTimersByTime(3_000);
    expect(texts().filter((t) => t.startsWith("START_VIDEO"))).toEqual([]);
  });

  it("passes the demand for the microphone on, plain and gzip-wrapped, and nothing for the camera", async () => {
    last().open();
    last().text("CAPTURE_DEMAND microphone 1");
    last().text("CAPTURE_DEMAND webcam 1");
    last().binary(0x05, ...(await gzip("CAPTURE_DEMAND microphone 0")));
    await vi.waitFor(() => expect(events.mic).toEqual([true, false]));
  });

  it("takes the channels from the server settings", () => {
    last().open();
    last().text(JSON.stringify({ type: "server_settings", settings: { audio_channels: { value: 1 } } }));
    expect(events.channels).toEqual([1]);
  });

  it("sends the microphone only on an open socket", () => {
    link.sendMic(new Uint8Array([2, 1, 0]));
    last().open();
    link.sendMic(new Uint8Array([2, 3, 4]));
    expect(last().sent.slice(1)).toEqual([new Uint8Array([2, 3, 4])]);
  });

  it("stops for good when a page of the desktop takes over", () => {
    last().open();
    last().text("CAPTURE_DEMAND microphone 1");
    last().text("KILL a new primary client connected connection killed");
    last().drop(1000);
    vi.advanceTimersByTime(30_000);
    expect(sockets).toHaveLength(1);
    expect(events.states.at(-1)).toEqual(["desktop", undefined]);
    expect(events.mic).toEqual([true, false]);
  });

  it("tries again after 1 s when Selkies refused a connection too close to another, 3 times", () => {
    for (let i = 0; i < 3; i++) {
      last().drop(4029);
      vi.advanceTimersByTime(999);
      expect(sockets).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(i + 2);
    }
    last().drop(4029);
    vi.advanceTimersByTime(30_000);
    expect(sockets).toHaveLength(4);
    expect(events.states.at(-1)?.[0]).toBe("unavailable");
  });

  it("tries again after a lost connection, waiting longer each time", () => {
    last().open();
    last().drop(1006);
    expect(events.states.at(-1)).toEqual(["retrying", undefined]);
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    last().drop(1006);
    vi.advanceTimersByTime(1_999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
  });

  it("tells the server's refusals apart: no audio at all, or no microphone", () => {
    last().open();
    last().text("MICROPHONE_DISABLED");
    expect(events.micDisabled).toBe(1);
    last().text("AUDIO_DISABLED");
    expect(events.states.at(-1)?.[0]).toBe("unavailable");
    last().drop(1000);
    vi.advanceTimersByTime(30_000);
    expect(sockets).toHaveLength(1);
  });

  it("closes on stop and never comes back", () => {
    last().open();
    link.stop();
    expect(last().closed).toBe(true);
    last().drop(1000);
    vi.advanceTimersByTime(30_000);
    expect(sockets).toHaveLength(1);
    expect(events.states.at(-1)).toEqual(["closed", undefined]);
  });
});
