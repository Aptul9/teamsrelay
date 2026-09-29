// The call audio in the local Google Chrome, headless, against a websocket the test routes and answers as Selkies
// would: Opus of a 440 Hz tone, made by Chrome's own encoder, goes down in 0x01 frames and the page plays 440 Hz; with
// a WAV of 660 Hz bursts as the fake microphone, the demand for the microphone brings 0x02 frames of 20 ms whose PCM
// at 24 kHz is 660 Hz, Mute stops them, and the end of the demand stops them and releases the microphone.
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page, type WebSocketRoute } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIC_RATE } from "@/lib/call-audio/frames";
import { tempDir } from "./helpers";

type Win = Window & { startCall(): void; call: { mute(on: boolean): void }; states: { link: string; mic: string }[]; micTracks: MediaStreamTrack[]; peak(): number };

const TONE_DOWN = 440;
const TONE_UP = 660;

let browser: Browser;
let page: Page;
let server: WebSocketRoute | null = null;
const received: (string | Buffer)[] = [];
let streaming: ReturnType<typeof setInterval> | null = null;

// 2 s of 48 kHz mono 16-bit PCM: 250 ms of the tone, 250 ms of silence (a steady tone would be taken for noise and
// suppressed by the noise suppression the call asks for)
function burstsWav(file: string, hz: number) {
  const rate = 48_000;
  const pcm = Buffer.alloc(rate * 2 * 2);
  for (let i = 0; i < rate * 2; i++) {
    const on = Math.floor(i / (rate / 4)) % 2 === 0;
    pcm.writeInt16LE(on ? Math.round(0.6 * 32767 * Math.sin((2 * Math.PI * hz * i) / rate)) : 0, i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, pcm]));
}

// the loudest frequency of 16-bit little-endian PCM, among 200-2000 Hz in 5 Hz steps (Goertzel)
function loudest(pcm: Buffer, rate: number): number {
  const n = pcm.length / 2;
  const x = Float64Array.from({ length: n }, (_, i) => pcm.readInt16LE(i * 2));
  let best = 0;
  let bestPower = -1;
  for (let f = 200; f <= 2000; f += 5) {
    const k = 2 * Math.cos((2 * Math.PI * f) / rate);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const s = x[i] + k * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    const power = s1 * s1 + s2 * s2 - k * s1 * s2;
    if (power > bestPower) [best, bestPower] = [f, power];
  }
  return best;
}

const micFrames = () => received.filter((m): m is Buffer => typeof m !== "string" && m[0] === 0x02);
const texts = () => received.filter((m): m is string => typeof m === "string");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(check: () => T | Promise<T>, what: string, timeout = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await check();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(50);
  }
}

beforeAll(async () => {
  const js = (
    await build({
      entryPoints: [path.join(__dirname, "call-audio-page.ts")],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      tsconfig: path.join(__dirname, "../tsconfig.json"),
      logLevel: "silent",
    })
  ).outputFiles[0].text;
  const wav = path.join(tempDir("teamsrelay-call-audio-"), "mic.wav");
  burstsWav(wav, TONE_UP);
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`],
  });
  page = await browser.newPage();
  await page.route("https://call.test/**", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><script>${js}</script></body></html>` }));
  await page.routeWebSocket("wss://call.test/desktop/api/websockets", (ws) => {
    server = ws;
    ws.onMessage((m) => received.push(m));
  });
  await page.goto("https://call.test/");
}, 60_000);

afterAll(async () => {
  if (streaming) clearInterval(streaming);
  await browser?.close();
});

describe("call audio in Chrome", () => {
  it("asks Selkies for the audio, never for the video, and plays the call", async () => {
    // 3 s of the tone, as Opus packets of 20 ms, from Chrome's own encoder
    const packets = await page.evaluate(async (hz) => {
      const out: number[][] = [];
      const encoder = new AudioEncoder({
        output: (chunk) => {
          const b = new Uint8Array(chunk.byteLength);
          chunk.copyTo(b);
          out.push([...b]);
        },
        error: (e) => console.error(e),
      });
      encoder.configure({ codec: "opus", sampleRate: 48_000, numberOfChannels: 2, bitrate: 64_000 });
      const n = 960;
      for (let f = 0; f < 150; f++) {
        const data = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) data[i] = data[n + i] = 0.5 * Math.sin((2 * Math.PI * hz * (f * n + i)) / 48_000);
        encoder.encode(new AudioData({ format: "f32-planar", sampleRate: 48_000, numberOfFrames: n, numberOfChannels: 2, timestamp: f * 20_000, data }));
      }
      await encoder.flush();
      return out;
    }, TONE_DOWN);
    expect(packets.length).toBeGreaterThan(100);

    await page.evaluate(() => (window as unknown as Win).startCall());
    await until(() => texts().includes("START_AUDIO"), "START_AUDIO");
    let next = 0;
    streaming = setInterval(() => server?.send(Buffer.from([0x01, 0x00, ...packets[next++ % packets.length]])), 20);

    await until(async () => (await page.evaluate(() => (window as unknown as Win).states.at(-1)?.link)) === "live", "live");
    await sleep(1_000);
    const peak = await page.evaluate(() => (window as unknown as Win).peak());
    expect(Math.abs(peak - TONE_DOWN)).toBeLessThanOrEqual(25);
    expect(texts().filter((t) => t.startsWith("START_VIDEO"))).toEqual([]);
    expect(micFrames()).toEqual([]);
  }, 30_000);

  it("sends the microphone while Selkies asks for it, 20 ms of 24 kHz PCM per frame", async () => {
    server?.send("CAPTURE_DEMAND microphone 1");
    await until(() => micFrames().length > 75, "1.5 s of microphone frames");
    const frames = micFrames();
    expect(new Set(frames.map((f) => f.length))).toEqual(new Set([1 + 480 * 2]));
    const pcm = Buffer.concat(frames.slice(-50).map((f) => f.subarray(1)));
    expect(Math.abs(loudest(pcm, MIC_RATE) - TONE_UP)).toBeLessThanOrEqual(25);
    expect(await page.evaluate(() => (window as unknown as Win).states.at(-1)?.mic)).toBe("on");
  }, 30_000);

  it("sends nothing while muted, and again once unmuted", async () => {
    await page.evaluate(() => (window as unknown as Win).call.mute(true));
    await sleep(150);
    const before = micFrames().length;
    await sleep(400);
    expect(micFrames().length).toBe(before);
    await page.evaluate(() => (window as unknown as Win).call.mute(false));
    await until(() => micFrames().length > before + 10, "frames after unmute");
  }, 30_000);

  it("stops the microphone and releases it when Selkies no longer asks for it", async () => {
    server?.send("CAPTURE_DEMAND microphone 0");
    await sleep(200);
    const before = micFrames().length;
    await sleep(400);
    expect(micFrames().length).toBe(before);
    const tracks = await page.evaluate(() => (window as unknown as Win).micTracks.map((t) => t.readyState));
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.every((s) => s === "ended")).toBe(true);
    expect(await page.evaluate(() => (window as unknown as Win).states.at(-1)?.mic)).toBe("off");
  }, 30_000);
});
