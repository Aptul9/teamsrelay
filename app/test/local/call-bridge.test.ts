// The sound of a call answered from the app on an account on another computer, end to end with no Teams: in the local
// Google Chrome, a page plays Teams (getUserMedia, then a peer connection to a far end in another context, as Teams web
// does), with the real hook of the relay (src/local/call-bridge-page.ts) and the real CallBridge behind its binding; the
// websocket goes to the real hub (src/server/call-audio-hub.ts) on an HTTP server of this process, and the page of the
// app opens the real CallAudio there. The far end sends 660 Hz, the fake microphone of the app 440 Hz bursts: each
// arrives at the other side, and the microphone of the computer is never opened while the call is the app's.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installMicHook } from "@/agent/teams/scripts/calls";
import { CallBridge } from "@/local/call-bridge";
import { attachCallAudioHub } from "@/server/call-audio-hub";
import { CALL_AUDIO_PATH } from "@/shared/relay-sync";
import { tempDir } from "../helpers";

const TONE_FAR = 660;
const TONE_APP = 440;
const TOKEN = "relay-token";

// Teams, as far as the sound goes: the microphone, one peer connection, the sound of the far end on an audio element
const TEAMS_PAGE = `<!doctype html><html><body><script>
const gathered = (pc) => new Promise((r) => { if (pc.iceGatheringState === "complete") return r(); pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && r()); });
window.offer = async () => {
  const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  window.mic = s.getAudioTracks()[0];
  const pc = (window.pc = new RTCPeerConnection());
  pc.ontrack = (e) => { const a = new Audio(); a.muted = true; a.srcObject = new MediaStream([e.track]); a.play().catch(() => undefined); };
  pc.addTrack(window.mic, s);
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  return pc.localDescription.toJSON();
};
window.finish = (answer) => window.pc.setRemoteDescription(answer);
window.gum = async () => (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0].label;
</script></body></html>`;

// The far end of the call: 660 Hz out, what it receives kept for the test
const FAR_PAGE = `<!doctype html><html><body><script>
const gathered = (pc) => new Promise((r) => { if (pc.iceGatheringState === "complete") return r(); pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && r()); });
window.answer = async (offer, hz) => {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const osc = ctx.createOscillator(); osc.frequency.value = hz;
  const gain = ctx.createGain(); gain.gain.value = 0.5;
  const out = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(out); osc.start();
  const pc = (window.pc = new RTCPeerConnection());
  pc.ontrack = (e) => { window.remote = e.track; const a = new Audio(); a.muted = true; a.srcObject = new MediaStream([e.track]); a.play().catch(() => undefined); };
  await pc.setRemoteDescription(offer);
  pc.addTrack(out.stream.getAudioTracks()[0], out.stream);
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return pc.localDescription.toJSON();
};
window.samples = async (ms) => {
  const r = new MediaStreamTrackProcessor({ track: window.remote }).readable.getReader();
  const out = []; const end = performance.now() + ms;
  while (performance.now() < end) { const { value, done } = await r.read(); if (done) break; const b = new Float32Array(value.numberOfFrames); value.copyTo(b, { planeIndex: 0, format: "f32-planar" }); value.close(); out.push(...b); }
  r.releaseLock();
  return out;
};
</script></body></html>`;

let root: string;
let server: http.Server;
let base: string;
let browser: Browser;
let teams: BrowserContext;
let teamsPage: Page;
let farPage: Page;
let appPage: Page;
let bridge: CallBridge;
let hub: ReturnType<typeof attachCallAudioHub>;
const checks: string[] = [];

// 48 kHz mono 16-bit PCM: 250 ms of the tone, 250 ms of silence (the app asks for noise suppression, which takes a
// steady tone for noise)
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

// the loudest frequency of the samples, among 200-2000 Hz in 5 Hz steps (Goertzel)
function loudest(x: number[], rate: number): number {
  let best = 0;
  let bestPower = -1;
  for (let f = 200; f <= 2000; f += 5) {
    const k = 2 * Math.cos((2 * Math.PI * f) / rate);
    let s1 = 0;
    let s2 = 0;
    for (const v of x) {
      const s = v + k * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    const power = s1 * s1 + s2 * s2 - k * s1 * s2;
    if (power > bestPower) [best, bestPower] = [f, power];
  }
  return best;
}
const rms = (x: number[]) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / Math.max(1, x.length));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(check: () => T | Promise<T>, what: string, timeout = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await check();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
}

type AppWin = Window & { startCall(url: string): void; call: { mute(on: boolean): void }; states: { link: string; mic: string }[]; peak(): number };
type TeamsWin = Window & { offer(): Promise<RTCSessionDescriptionInit>; finish(a: RTCSessionDescriptionInit): Promise<void>; gum(): Promise<string>; mic: MediaStreamTrack; originalCalls: number; __teamsMicTracks?: MediaStreamTrack[] };
type FarWin = Window & { answer(o: RTCSessionDescriptionInit, hz: number): Promise<RTCSessionDescriptionInit>; samples(ms: number): Promise<number[]> };

const appState = () => appPage.evaluate(() => (window as unknown as AppWin).states.at(-1));

beforeAll(async () => {
  root = tempDir("teamsrelay-bridge-");
  const wav = path.join(root, "mic.wav");
  burstsWav(wav, TONE_APP);
  const appJs = (
    await build({
      entryPoints: [path.join(__dirname, "../call-audio-page.ts")],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      tsconfig: path.join(__dirname, "../../tsconfig.json"),
      logLevel: "silent",
    })
  ).outputFiles[0].text;
  const pages: Record<string, string> = {
    "/app": `<!doctype html><html><body><script>${appJs}</script></body></html>`,
    "/teams": TEAMS_PAGE,
    "/far": FAR_PAGE,
  };
  server = http.createServer((req, res) => {
    const body = pages[new URL(req.url ?? "/", "http://x").pathname];
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html" }).end(body);
  });
  // the web app says who opens a socket: the relay by its token, the page of the app of account 1
  hub = attachCallAudioHub(server, {
    check: async (req) => {
      const side = req.headers.authorization === `Bearer ${TOKEN}` ? "relay" : new URL(req.url ?? "/", "http://x").searchParams.get("a") === "1" ? "app" : null;
      checks.push(side ?? "refused");
      return side ? { slot: 1, side } : null;
    },
    relayWaitMs: 3_000,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav}`,
      // host candidates by address: the far end asks for no microphone, and would offer mDNS names only
      "--disable-features=WebRtcHideLocalIpsWithMdns",
    ],
  });
  teams = await browser.newContext();
  // counts the calls that reach the microphone of the computer, under the hook of the relay
  await teams.addInitScript(() => {
    const w = window as unknown as TeamsWin;
    const md = navigator.mediaDevices;
    const original = md.getUserMedia.bind(md);
    w.originalCalls = 0;
    md.getUserMedia = (c) => {
      w.originalCalls++;
      return original(c);
    };
  });
  bridge = new CallBridge({ url: base, token: TOKEN });
  await bridge.attach(teams);
  // the agent's microphone hook comes after the bridge, as in the relay: it must see the track the bridge hands out
  await teams.addInitScript(installMicHook);
  teamsPage = await teams.newPage();
  await teamsPage.goto(`${base}/teams`);
  farPage = await (await browser.newContext()).newPage();
  await farPage.goto(`${base}/far`);
  appPage = await (await browser.newContext()).newPage();
  await appPage.goto(`${base}/app`);
}, 60_000);

afterAll(async () => {
  bridge?.stop();
  await browser?.close();
  hub?.close();
  server?.close();
});

describe("call sound of an account on another computer, loopback", () => {
  it("refuses a socket the web app does not know", async () => {
    const r = await appPage.evaluate(
      (url) =>
        new Promise<string>((resolve) => {
          const s = new WebSocket(url);
          s.onopen = () => resolve("open");
          s.onerror = () => resolve("refused");
        }),
      `${base.replace("http", "ws")}${CALL_AUDIO_PATH}?a=2`,
    );
    expect(r).toBe("refused");
  });

  it("carries the far end to the app and the app's microphone to the far end, never the computer's", async () => {
    // Answer in the app: the sound opens from the tap, then the relay gets the answer command and arms the bridge
    await appPage.evaluate((url) => (window as unknown as AppWin).startCall(url), `${base.replace("http", "ws")}${CALL_AUDIO_PATH}?a=1`);
    await until(() => hub.pairs.get(1)?.app, "app socket on the hub");
    bridge.arm();
    await until(async () => (await appState())?.link === "live", "app live once the relay is there");

    // Teams takes the call: the microphone, the peer connection, the far end
    const offer = await teamsPage.evaluate(() => (window as unknown as TeamsWin).offer());
    const answer = await farPage.evaluate(({ o, hz }) => (window as unknown as FarWin).answer(o, hz), { o: offer, hz: TONE_FAR });
    await teamsPage.evaluate((a) => (window as unknown as TeamsWin).finish(a), answer);
    expect(bridge.live).toBe(true);
    expect(await teamsPage.evaluate(() => (window as unknown as TeamsWin).originalCalls)).toBe(0);
    // the call watch of the agent sees a call in progress
    expect(await teamsPage.evaluate(() => ((window as unknown as TeamsWin).__teamsMicTracks ?? []).filter((t) => t.readyState === "live").length)).toBe(1);

    // the app's microphone, asked for by the relay, reaches the far end
    await until(async () => (await appState())?.mic === "on", "app microphone on");
    await sleep(1_500);
    const up = await farPage.evaluate(() => (window as unknown as FarWin).samples(1_000));
    expect(rms(up)).toBeGreaterThan(0.01);
    expect(Math.abs(loudest(up, 48_000) - TONE_APP)).toBeLessThanOrEqual(25);

    // the far end reaches the app
    const down = await until(async () => {
      const p = await appPage.evaluate(() => (window as unknown as AppWin).peak());
      return Math.abs(p - TONE_FAR) <= 25 ? p : null;
    }, "660 Hz in the app");
    expect(Math.abs(down - TONE_FAR)).toBeLessThanOrEqual(25);
  }, 60_000);

  it("sends silence while the app is muted", async () => {
    await appPage.evaluate(() => (window as unknown as AppWin).call.mute(true));
    await sleep(800);
    expect(rms(await farPage.evaluate(() => (window as unknown as FarWin).samples(800)))).toBeLessThan(0.005);
    await appPage.evaluate(() => (window as unknown as AppWin).call.mute(false));
    await until(async () => rms(await farPage.evaluate(() => (window as unknown as FarWin).samples(500))) > 0.01, "sound again once unmuted");
  }, 30_000);

  it("ends with the call in Teams, and the next microphone is the computer's", async () => {
    await teamsPage.evaluate(() => (window as unknown as TeamsWin).mic.stop());
    await until(() => !bridge.live, "bridge over");
    await until(async () => (await appState())?.mic === "off", "app microphone released");
    // a call answered in the Teams window, not from the app: the microphone of the computer, untouched
    expect(await teamsPage.evaluate(() => (window as unknown as TeamsWin).gum())).toContain("Fake");
    expect(await teamsPage.evaluate(() => (window as unknown as TeamsWin).originalCalls)).toBe(1);
    expect(checks).toContain("relay");
    expect(checks).toContain("app");
  }, 30_000);
});
