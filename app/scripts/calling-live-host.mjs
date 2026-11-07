// Browserless Teams calling host for the isolated Bandpey slot 7: the shipped Teams calling stack with native WebRTC
// (@roamhq/wrtc) in Node, no browser. Runs in its own container:
//   WRTC_DIR     (/work)  a directory whose node_modules holds @roamhq/wrtc, read-only
//   HOST_BUNDLES (/host)  pinned vendor bundles cmd-trouter.js and calling-pluginless.js, read-only
//   HOST_STATE   (/state) private state: fresh discovery.json in, ownership marker and receipts out
// Modes: init   = register, build the calling stack, initialize the registry, clean up (no call)
//        answer = as init, then answer one call from the owned peer, talk, mute, unmute, hang up locally
//        echo   = call Microsoft's Teams test-call service, which plays back what it heard; hang up
import { CallingAudioBridge } from "./calling-audio-bridge.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { decodeIncomingPayload, loadTrouterBundle } from "./trouter-offline-probe.mjs";
import { callingRoutes, incomingPeerMatches, permittedCallingRequest, registrarSucceeded, registrationWrites, reserveRegistration, trouterSettings } from "./trouter-live-probe.mjs";
import { callingRequestAllowed, dominantNotes, melodyFrame, safePath, scrub } from "./calling-host-helpers.mjs";

const TROUTER_SHA256 = "ae686dad9c49f198dc2fe41bdd68a78ca29e38b1c070f3d708fd1ea08aeabae8";
const CALLING_SHA256 = "7df71e7009a880cc0fe6cd83b0ae201de00698ec670030369c9e3a893aad74d9";
let BANDPEY_OID = process.env.CALLING_OID ?? "e14ae6fe-3ef7-447b-87f8-b0bde1b2607e";
const STATE = process.env.HOST_STATE ?? "/state";
const BUNDLES = process.env.HOST_BUNDLES ?? "/host";
const nativeRequire = createRequire(path.join(process.env.WRTC_DIR ?? "/work", "package.json"));
const wrtc = nativeRequire("@roamhq/wrtc");
// node-webrtc's EventTarget omits target; the Teams data-channel callbacks require the browser Event contract.
const NativeEventTarget = nativeRequire("@roamhq/wrtc/lib/eventtarget.js");
const nativeDispatch = NativeEventTarget.prototype.dispatchEvent;
NativeEventTarget.prototype.dispatchEvent = function (event) {
  if (!event.target) Object.defineProperty(event, "target", { value: this, configurable: true });
  if (!event.currentTarget) Object.defineProperty(event, "currentTarget", { value: this, configurable: true });
  return nativeDispatch.call(this, event);
};

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const MODE = arg("mode") ?? "init";
assert(["init", "answer", "echo", "serve"].includes(MODE), "mode must be init, answer or echo");
// Microsoft's Teams test-call service (config-prod teamsEchoBotMri): records what it hears, then plays it back
const ECHO_BOT = "28:cf28171e-fcfd-47e4-a1d6-79460b0b3ca0";
if (MODE === "echo") assert(Number(arg("talk-seconds") ?? 0) >= 20 && Number(arg("talk-seconds")) <= 60, "echo talk-seconds 20-60");
const LISTEN = Number(arg("listen-seconds") ?? 0);
const PEER = (arg("peer-mri") ?? "").toLowerCase();
const TALK = Number(arg("talk-seconds") ?? 8);
if (MODE === "answer") assert(TALK <= 20, "answer talk-seconds up to 20");
if (MODE === "answer") {
  assert(LISTEN >= 1 && LISTEN <= 120, "listen-seconds 1-120");
  assert(/^8:orgid:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(PEER), "owned peer MRI required");
  assert(TALK >= 3 && TALK <= 20, "talk-seconds 3-20");
}

const t0 = Date.now();
const since = () => Date.now() - t0;
const emit = (value) => { process.send?.(value); process.stdout.write(JSON.stringify({ t: since(), ...value }) + "\n"); };
const stackPath = path.join(STATE, "host-stack.log");
try { fs.renameSync(stackPath, path.join(STATE, "host-stack.previous.log")); } catch {}
const logFile = fs.openSync(stackPath, "w", 0o600);
const stackLog = (level, text) => fs.writeSync(logFile, `${since()} ${level} ${scrub(text).slice(0, 2000)}\n`);
const receipt = { mode: MODE, startedAt: new Date(t0).toISOString(), stages: [], requests: [], denied: [], trouterEvents: [], tokenRequests: [], peerConnections: [], calls: [], audio: {}, timeline: [], unhandled: [], failure: null };
const stage = (name, extra = {}) => { receipt.stages.push({ name, t: since(), ...extra }); emit({ stage: name, ...extra }); };
const mark = (name, extra = {}) => { receipt.timeline.push({ name, at: Date.now(), t: since(), ...extra }); emit({ mark: name, ...extra }); };
process.on("uncaughtException", (e) => { receipt.failure = scrub(e?.stack ?? e).slice(0, 1800); fs.writeFileSync(path.join(STATE, "crash.json"), JSON.stringify({ error: receipt.failure }), { mode: 0o600 }); emit({ fatal: receipt.failure }); if (MODE === "serve") process.kill(process.pid, "SIGTERM"); });
process.on("unhandledRejection", (e) => { if (receipt.unhandled.length < 40) receipt.unhandled.push(scrub(e?.stack ?? e?.message ?? JSON.stringify(e)).slice(0, 600)); });

// --- network policy: calling stack HTTP goes only to Teams/Skype service hosts over https (callingRequestAllowed)
async function guardedFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input.url;
  const method = (init.method ?? input?.method ?? "GET").toUpperCase();
  if (!callingRequestAllowed(url)) {
    let target = "<invalid>";
    try { const u = new URL(url); target = `${u.protocol}//${u.hostname}${safePath(u.pathname)}`; } catch {}
    receipt.denied.push({ t: since(), method, target });
    throw new TypeError("Failed to fetch (denied by browserless host policy)");
  }
  const u = new URL(url);
  const started = Date.now();
  const entry = { t: since(), method, host: u.hostname, path: safePath(u.pathname) };
  receipt.requests.push(entry);
  try {
    // browser-only fetch options: credentials and keepalive mean nothing to Node's fetch
    const rest = { ...init };
    delete rest.credentials;
    delete rest.keepalive;
    const response = await fetch(url, { ...rest, method, redirect: "manual", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    entry.status = response.status;
    entry.ms = Date.now() - started;
    return response;
  } catch (e) {
    entry.error = String(e?.message ?? e).slice(0, 200);
    throw e;
  }
}

// --- microphone: the test melody (calling-host-helpers.mjs), fed in 10 ms frames while a call is up
const micSource = new wrtc.nonstandard.RTCAudioSource();
const micTracks = [];
let hubBridge = null;
let hubSocket = null;
async function connectAudioHub() {
  if (!process.env.CALL_AUDIO_URL) return;
  const url = new URL(process.env.CALL_AUDIO_URL);
  assert(["ws:", "wss:"].includes(url.protocol) && !url.username && !url.password && url.pathname === "/api/call/audio/socket", "invalid audio hub URL");
  assert(url.protocol === "wss:" || ["127.0.0.1", "localhost"].includes(url.hostname) || (process.env.CALL_AUDIO_INTERNAL === "1" && url.hostname === "teams-webapp"), "unencrypted hub must be loopback");
  const codec = nativeRequire(process.env.OPUS_MODULE ?? "opusscript");
  // Node's standard WebSocket cannot supply Authorization. ws is loaded from the host's existing runtime.
  const WS = nativeRequire(process.env.WS_MODULE ?? "ws");
  const headers = process.env.CALL_AUDIO_TOKEN_FILE ? { Authorization: `Bearer ${fs.readFileSync(process.env.CALL_AUDIO_TOKEN_FILE, "utf8").trim()}` } : {};
  hubSocket = new WS(url.href, { headers, maxPayload: 65536, handshakeTimeout: 10000 });
  hubBridge = new CallingAudioBridge({ codec, send: (v) => { if (hubSocket.readyState === 1 && hubSocket.bufferedAmount < 65536) hubSocket.send(v); } });
  const connectionBridge = hubBridge;
  hubSocket.on("message", (data, binary) => { if (binary) connectionBridge.receive(data); });
  await new Promise((resolve, reject) => { hubSocket.once("open", resolve); hubSocket.once("error", reject); });
  hubSocket.on("error", (e) => { receipt.audioHubError = e.message; });
  hubSocket.on("close", () => { connectionBridge.close(); });
  hubBridge.start();
  mark("audio-hub-connected");
}
let micTimer = null;
let micSample = 0;
let micFrames = 0;
function startTone() {
  if (micTimer) return;
  const frame = new Int16Array(480);
  // wall-clock pacing: send every 10 ms frame that elapsed time says is due (Node intervals drift late)
  const startedAt = performance.now();
  micFrames = 0;
  micTimer = setInterval(() => {
    const due = Math.floor((performance.now() - startedAt) / 10);
    // Never replay a stalled event loop as a burst of stale audio.
    if (due - micFrames > 5) micFrames = due - 5;
    while (micFrames < due) feedOne();
  }, 5);
  function feedOne() {
    if (hubBridge) frame.set(hubBridge.microphone());
    else melodyFrame(micSample, frame);
    micSample += 480; micFrames++;
    micSource.onData({ samples: frame, sampleRate: 48000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 480 });
    for (const [out, track] of micOutputs) out.onData({ samples: track.enabled ? frame : SILENCE, sampleRate: 48000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 480 });
  }
}
function stopTone() { if (micTimer) clearInterval(micTimer); micTimer = null; }
// the stack matches a capture track to the selected device by getSettings().deviceId; the native prototype member is
// read-only, so the track gets its own property
const settingsOf = (track) => () => ({ deviceId: "default", groupId: "teamsrelay", sampleRate: 48000, channelCount: 1, echoCancellation: false, autoGainControl: false, noiseSuppression: false, kind: track.kind });
const withSettings = (track) => { try { Object.defineProperty(track, "getSettings", { value: settingsOf(track), configurable: true }); } catch (e) { receipt.settingsPatchError = String(e?.message ?? e).slice(0, 160); } return track; };
function micStream() {
  const track = withSettings(micSource.createTrack());
  micTracks.push(track);
  return new wrtc.MediaStream([track]);
}
// mixer outputs fed with the same tone frames as the microphone (the stack mixes local audio through Web Audio).
// A disabled source track contributes silence, as Web Audio does: the stack mutes by disabling the source clone.
const micOutputs = new Map();
const SILENCE = new Int16Array(480);

// --- speaker: every audio element attaches native sinks and measures what the peer sends
const sinks = [];
const heard = { frames: 0, windows: [], current: null, sampleRate: 0, channels: 0 };
function closeWindow() {
  const w = heard.current;
  if (!w || !w.values.length) return;
  const rate = heard.sampleRate || 48000;
  const rms = Math.sqrt(w.values.reduce((a, v) => a + v * v, 0) / w.values.length);
  // per 100 ms: which melody note or the peer's tone dominates, if any
  heard.windows.push({ second: w.second, samples: w.values.length, rms: Math.round(rms), notes: dominantNotes(w.values, rate).join(",") });
}
function onSinkData(frame) {
  hubBridge?.speaker(frame);
  heard.frames++;
  heard.sampleRate = frame.sampleRate; heard.channels = frame.channelCount;
  const second = Math.floor(since() / 1000);
  if (!heard.current || heard.current.second !== second) { closeWindow(); heard.current = { second, values: [] }; }
  for (let i = 0; i < frame.numberOfFrames; i++) {
    let v = 0;
    for (let c = 0; c < frame.channelCount; c++) v += frame.samples[i * frame.channelCount + c];
    heard.current.values.push(v / frame.channelCount);
  }
}
class AudioElement {
  constructor() { this.listeners = {}; this.autoplay = false; this.volume = 1; this.muted = false; this.paused = true; this._stream = null; this._sinks = []; this.nodeName = "AUDIO"; this.style = {}; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  get srcObject() { return this._stream; }
  set srcObject(stream) {
    for (const sink of this._sinks) { sink.ondata = null; sink.stop(); }
    this._sinks = [];
    this._stream = stream ?? null;
    if (!stream) return;
    for (const track of stream.getAudioTracks()) {
      const sink = new wrtc.nonstandard.RTCAudioSink(track);
      sink.ondata = onSinkData;
      this._sinks.push(sink); sinks.push(sink);
    }
    mark("speaker-attached", { tracks: this._sinks.length });
  }
  play() { this.paused = false; for (const fn of this.listeners.play ?? []) fn({ target: this }); return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  setAttribute() {}
  removeAttribute() {}
}

// --- Web Audio, only as far as the stack's send mixer uses it: sources connect to a destination stream whose track
// carries their frames. Our own microphone tracks feed the destination directly from the tone loop; any other track
// is forwarded through a native sink.
const audioGraph = { contexts: 0, destinations: 0, sources: 0, forwardedTracks: 0 };
class AudioContextShim {
  constructor() { this.state = "running"; this.sampleRate = 48000; this.currentTime = 0; this.destination = { connect() {}, disconnect() {} }; audioGraph.contexts++; }
  createMediaStreamDestination() {
    const source = new wrtc.nonstandard.RTCAudioSource();
    const track = withSettings(source.createTrack());
    micTracks.push(track);
    audioGraph.destinations++;
    return { stream: new wrtc.MediaStream([track]), _source: source, connect: (d) => d, disconnect() {} };
  }
  createMediaStreamSource(stream) {
    audioGraph.sources++;
    let detach = [];
    return {
      mediaStream: stream,
      connect(dest) {
        const out = dest?._source;
        if (!out) return dest;
        for (const track of stream.getAudioTracks()) {
          if (micTracks.some((t) => t.id === track.id)) { micOutputs.set(out, track); detach.push(() => micOutputs.delete(out)); continue; }
          const sink = new wrtc.nonstandard.RTCAudioSink(track);
          // a native sink on a local track keeps receiving while the track is disabled: honour enabled here
          sink.ondata = (f) => out.onData({ samples: track.enabled ? f.samples : new Int16Array(f.samples.length), sampleRate: f.sampleRate, bitsPerSample: 16, channelCount: f.channelCount, numberOfFrames: f.numberOfFrames });
          sinks.push(sink); audioGraph.forwardedTracks++;
          detach.push(() => { sink.ondata = null; sink.stop(); });
        }
        return dest;
      },
      disconnect() { for (const d of detach) d(); detach = []; },
    };
  }
  createGain() { return { gain: { value: 1, setValueAtTime() {} }, connect: (d) => d, disconnect() {} }; }
  createAnalyser() { return { fftSize: 2048, frequencyBinCount: 1024, getFloatTimeDomainData() {}, getByteFrequencyData() {}, getFloatFrequencyData() {}, connect: (d) => d, disconnect() {} }; }
  resume() { this.state = "running"; return Promise.resolve(); }
  suspend() { this.state = "suspended"; return Promise.resolve(); }
  close() { this.state = "closed"; return Promise.resolve(); }
  addEventListener() {}
  removeEventListener() {}
}

// --- browser surface for the calling VM
const realTimers = new Map();
let timerSeq = 0;
function vmTimer(fn, ms, repeat, extra) {
  const id = ++timerSeq;
  const run = () => { if (!repeat) realTimers.delete(id); try { fn(...extra); } catch (e) { if (receipt.unhandled.length < 40) receipt.unhandled.push(scrub(e?.stack ?? e).slice(0, 600)); } };
  const handle = repeat ? setInterval(run, Math.max(Number(ms) || 0, 4)) : setTimeout(run, Math.max(Number(ms) || 0, 0));
  handle.unref?.();
  realTimers.set(id, handle);
  return id;
}
function clearVmTimer(id) { const h = realTimers.get(id); if (h) { clearTimeout(h); clearInterval(h); realTimers.delete(id); } }
const disposable = () => ({ dispose() {} });
const events = () => ({ addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
const element = (tag) => ({ nodeName: String(tag).toUpperCase(), style: {}, children: [], ...events(), appendChild: (c) => c, removeChild: (c) => c, setAttribute() {}, removeAttribute() {}, getContext: () => null, canPlayType: () => "", querySelector: () => null, querySelectorAll: () => [] });
const body = element("body");
const document = {
  ...events(), hidden: false, visibilityState: "visible", readyState: "complete", cookie: "", body, head: element("head"), documentElement: element("html"),
  createElement: (tag) => (String(tag).toLowerCase() === "audio" ? new AudioElement() : element(tag)),
  createElementNS: (_ns, tag) => element(tag), querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, hasFocus: () => true,
};
const deviceList = () => [
  { deviceId: "default", kind: "audioinput", label: "Default - TeamsRelay microphone", groupId: "teamsrelay", toJSON() { return { ...this }; } },
  { deviceId: "default", kind: "audiooutput", label: "Default - TeamsRelay speaker", groupId: "teamsrelay", toJSON() { return { ...this }; } },
];
const captureLog = [];
const navigator = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  appVersion: "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  platform: "Win32", language: "en-US", languages: ["en-US"], vendor: "Google Inc.", onLine: true, hardwareConcurrency: 4, maxTouchPoints: 0, cookieEnabled: true,
  mediaDevices: {
    ...events(),
    enumerateDevices: async () => deviceList(),
    getSupportedConstraints: () => ({ deviceId: true, echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: true, channelCount: true }),
    getUserMedia: async (constraints) => {
      captureLog.push({ t: since(), audio: !!constraints?.audio, video: !!constraints?.video });
      if (constraints?.video && !constraints?.audio) throw Object.assign(new Error("Requested device not found"), { name: "NotFoundError" });
      return micStream();
    },
  },
  getUserMedia(constraints, ok, fail) { navigator.mediaDevices.getUserMedia(constraints).then(ok, fail); },
};
const globals = {
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} },
  performance: { now: () => performance.now(), timeOrigin: performance.timeOrigin, mark() {}, measure() {}, getEntriesByName: () => [], clearMarks() {}, clearMeasures() {} },
  URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal, Headers, Request, Response, Blob, Event, EventTarget, DOMException,
  structuredClone, queueMicrotask,
  atob: (s) => Buffer.from(String(s), "base64").toString("binary"),
  btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
  crypto: { getRandomValues: (a) => webcrypto.getRandomValues(a), randomUUID: () => randomUUID(), subtle: webcrypto.subtle },
  setTimeout: (fn, ms, ...extra) => vmTimer(fn, ms, false, extra), clearTimeout: clearVmTimer,
  setInterval: (fn, ms, ...extra) => vmTimer(fn, ms, true, extra), clearInterval: clearVmTimer,
  requestAnimationFrame: (fn) => vmTimer(() => fn(performance.now()), 16, false, []), cancelAnimationFrame: clearVmTimer,
  fetch: guardedFetch,
  WebSocket: class { constructor(url) { receipt.denied.push({ t: since(), method: "WEBSOCKET", target: String(url).slice(0, 60) }); throw new Error("WebSocket denied in calling VM"); } },
  XMLHttpRequest: class { constructor() { receipt.denied.push({ t: since(), method: "XHR", target: "-" }); throw new Error("XMLHttpRequest denied in calling VM"); } },
  document, navigator, location: new URL("https://teams.microsoft.com/v2/"),
  localStorage: memoryStorage(), sessionStorage: memoryStorage(),
  screen: { width: 1920, height: 1080, colorDepth: 24 },
  matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, ...events() }),
  AudioContext: AudioContextShim, webkitAudioContext: AudioContextShim,
  ...events(),
};
function memoryStorage() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; }
globals.window = globals; globals.self = globals;
for (const key of ["MediaStream", "MediaStreamTrack", "RTCSessionDescription", "RTCIceCandidate", "RTCRtpReceiver", "RTCRtpSender", "RTCRtpTransceiver", "RTCDataChannel"]) if (wrtc[key]) globals[key] = wrtc[key];
const nativePeers = [];
globals.RTCPeerConnection = new Proxy(wrtc.RTCPeerConnection, {
  construct(Target, args) {
    const config = args[0] ?? {};
    const pc = new Target(...args);
    nativePeers.push(pc);
    const row = { t: since(), iceServers: (config.iceServers ?? []).map((s) => [].concat(s.urls ?? s.url ?? []).map((u) => String(u).split("?")[0])).flat(), policy: config.iceTransportPolicy, bundle: config.bundlePolicy, states: [] };
    receipt.peerConnections.push(row);
    row.stats = [];
    const poll = setInterval(async () => {
      if (pc.signalingState === "closed" || row.stats.length >= 40) { clearInterval(poll); return; }
      try {
        const report = await pc.getStats();
        const s = { t: since() };
        const byId = new Map();
        report.forEach((v) => byId.set(v.id, v));
        report.forEach((v) => {
          if (v.type === "outbound-rtp" && (v.kind ?? v.mediaType) === "audio") Object.assign(s, { sentPackets: v.packetsSent, sentBytes: v.bytesSent });
          if (v.type === "media-source" && v.kind === "audio") Object.assign(s, { srcLevel: v.audioLevel, srcEnergy: v.totalAudioEnergy });
          if (v.type === "track" && v.kind === "audio" && v.remoteSource === false) Object.assign(s, { trkLevel: v.audioLevel });
          if (v.type === "inbound-rtp" && (v.kind ?? v.mediaType) === "audio") Object.assign(s, { recvPackets: v.packetsReceived, recvLost: v.packetsLost, jitter: v.jitter });
          if (v.type === "candidate-pair" && (v.nominated || v.selected) && v.state === "succeeded") {
            const l = byId.get(v.localCandidateId), r = byId.get(v.remoteCandidateId);
            s.pair = `${l?.candidateType}/${l?.protocol}->${r?.candidateType}/${r?.protocol}`;
          }
        });
        s.tx = pc.getTransceivers().map((t) => `${t.mid}:${t.direction}/${t.currentDirection}:${t.sender.track ? `${t.sender.track.kind}:${t.sender.track.id.slice(0, 8)}:${t.sender.track.readyState}:${t.sender.track.enabled}:${micTracks.some((m) => m.id === t.sender.track.id) ? "ours" : "other"}` : "no-track"}`).join(" ");
        s.mics = micTracks.map((m) => `${m.id.slice(0, 8)}:${m.readyState}:${m.enabled}`).join(" ");
        row.stats.push(s);
      } catch (e) { row.statsError = String(e?.message ?? e).slice(0, 120); clearInterval(poll); }
    }, 2000);
    poll.unref?.();
    pc.addEventListener?.("iceconnectionstatechange", () => row.states.push(`${since()}:ice:${pc.iceConnectionState}`));
    pc.addEventListener?.("connectionstatechange", () => row.states.push(`${since()}:pc:${pc.connectionState}`));
    return pc;
  },
});
globals.RTCPeerConnection.generateCertificate = wrtc.RTCPeerConnection.generateCertificate;

// --- logger surface the stack expects (child loggers, safe/unsafe, fn loggers)
function makeLogger(prefix = "") {
  const fn = (level) => (...a) => stackLog(level, `${prefix}${a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ")}`);
  const logger = { log: fn("log"), debug: fn("debug"), info: fn("info"), warn: fn("warn"), error: fn("error"), verbose: fn("verbose"), trace: fn("trace"), logFailure: fn("failure"), infoToTelemetry: fn("info") };
  logger.safe = logger; logger.unsafe = logger;
  logger.createChild = (name) => makeLogger(`${prefix}[${typeof name === "function" ? name() : name}]`);
  logger.createFnLogger = (name, cause) => makeLogger(`${prefix}[${name}][${cause}]`);
  return logger;
}

async function main() {
  const discovery = JSON.parse(fs.readFileSync(path.join(STATE, "discovery.json"), "utf8"));
  assert(Date.now() - fs.statSync(path.join(STATE, "discovery.json")).mtimeMs < 15 * 60_000, "fresh discovery required");
  let token = discovery.tokens?.skypeToken;
  assert(typeof token === "string" && token.length > 100, "no Skype token");
  let tokenExpiry = Math.floor(fs.statSync(path.join(STATE, "discovery.json")).mtimeMs / 1000) + Number(discovery.tokens.expiresIn ?? 3600);
  let tokenRefresh = null;
  async function freshToken(force = false) {
    if (MODE !== "serve" || (!force && Date.now() / 1000 < tokenExpiry - 300)) return token;
    if (!tokenRefresh) tokenRefresh = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("calling token refresh timeout")), 20000);
      const receive = message => {
        if (message?.tokenUpdated) {
          clearTimeout(timeout); process.off("message", receive);
          const next = JSON.parse(fs.readFileSync(path.join(STATE, "discovery.json"), "utf8"));
          token = next.tokens.skypeToken;
          tokenExpiry = Math.floor(Date.now()/1000) + Number(next.tokens.expiresIn ?? 3600);
          resolve(token);
        }
      };
      process.on("message", receive); process.send?.({ refreshToken: true });
    }).finally(() => { tokenRefresh = null; });
    return tokenRefresh;
  }
  const tenantId = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).tid ?? discovery.tenantId;
  const routes = callingRoutes(discovery);
  const trouterSource = fs.readFileSync(path.join(BUNDLES, "cmd-trouter.js"));
  assert.equal(createHash("sha256").update(trouterSource).digest("hex"), TROUTER_SHA256);
  const callingSource = fs.readFileSync(path.join(BUNDLES, "calling-pluginless.js"), "utf8");
  assert.equal(createHash("sha256").update(callingSource).digest("hex"), CALLING_SHA256);

  // relay agent configuration, the same anonymous ECS request the web client makes
  const ecs = await guardedFetch(`https://config.teams.microsoft.com/config/v1/Skype/1415_1.0.0.0?tenantId=${tenantId}&aadUserId=${BANDPEY_OID}&userId=${BANDPEY_OID}&region=${discovery.region}&agents=MDN_TRAP&ECSCanary=1`, { headers: { "X-ECS-Client-Last-Telemetry-Events": "ecs_client_library_name=@1js/ecs-client,ecs_client_app_name=SkypeEcsConfigAdapter,ecs_client_version=1.2.0" } });
  assert.equal(ecs.status, 200, "ECS relay config");
  const relayConfig = (await ecs.json()).MDN_TRAP;
  assert(relayConfig?.Service?.tokenUrl, "no relay token service in ECS");
  stage("relay-config", { tokenUrlHost: new URL(relayConfig.Service.tokenUrl).hostname, turn: relayConfig.Relay?.Turn?.fqdns?.[0] ?? null });

  // --- Trouter registration (same guarded path as the committed live probe)
  const endpoint = randomUUID();
  const ownership = path.join(STATE, "owned-registration.json");
  reserveRegistration(ownership, { endpoint, registrar: routes.registrar });
  const sockets = [];
  const writes = registrationWrites();
  let registrationAttempted = false;
  let resolveRegistered;
  const registered = new Promise((r) => { resolveRegistered = r; });
  const trouterRequests = [];
  const trouterFetch = async (input) => {
    const req = input instanceof Request ? input : new Request(input);
    assert(permittedCallingRequest(req.url, req.method, routes, endpoint), "unexpected Trouter request blocked");
    const url = new URL(req.url);
    const isRegistration = req.method === "POST" && url.href === routes.registrar;
    if (isRegistration) assert.equal((await req.clone().json()).registrationId, endpoint);
    const perform = () => fetch(req, { redirect: "manual", signal: AbortSignal.any([req.signal, AbortSignal.timeout(15000)]) });
    const response = isRegistration ? await writes.send(() => { registrationAttempted = true; return perform(); }) : await perform();
    trouterRequests.push({ method: req.method, host: url.hostname, path: url.pathname.startsWith(new URL(routes.registrar).pathname) ? new URL(routes.registrar).pathname + (req.method === "DELETE" ? "/<owned-endpoint>" : "") : url.pathname, status: response.status });
    if (isRegistration && response.ok) resolveRegistered();
    return response;
  };
  class GuardedWebSocket extends WebSocket {
    constructor(url) { assert(permittedCallingRequest(url, "WEBSOCKET", routes, endpoint), "unexpected WebSocket blocked"); super(url); sockets.push(this); }
  }
  const trouterRuntime = loadTrouterBundle(trouterSource.toString("utf8"), trouterFetch, GuardedWebSocket);
  const trouterLogger = Object.fromEntries(["debug", "info", "warn", "error"].map((k) => [k, (t) => stackLog(`trouter.${k}`, String(t))]));
  const service = trouterRuntime.api.createTrouterService(trouterLogger);
  let stack, registry, cleanupDone = false;
  let answeredCall = null;
  let gatedCallSeen = false;
  let ownedIncomingId = null;

  try {
    service.start({
      authTokenProvider: async (p) => { assert(p.supportedTokenTypes.includes("skype"), "different calling token required"); return { token: await freshToken(!!p.needFresh), tokenType: "skype" }; },
      trouterSettings: trouterSettings(routes, endpoint, trouterRuntime.api.getTrouterServiceVersion()),
      telemetryConfig: { settings: {}, eventLogger: { logEvent() {} } },
    });
    let deadline;
    const surl = await Promise.race([
      Promise.all([service.getTrouterUrlAsync(), registered]).then(([u]) => u),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Trouter registration did not complete within 25 s")), 25000); }),
    ]);
    clearTimeout(deadline);
    assert(/^https:\/\/[a-z0-9.-]+\.trouter\.teams\.microsoft\.com(:\d+)?\//i.test(surl), "unexpected Trouter URL");
    stage("trouter-registered", { surlHost: new URL(surl).hostname });

    // --- calling stack
    const logger = makeLogger();
    const trouterUrl = () => surl;
    for (const k of ["changed", "on", "once", "onAsync", "onceAsync", "changedAsync"]) { const f = () => disposable(); f.off = () => {}; trouterUrl[k] = f; }
    const trouterUrlGetter = { trouterUrl, getTrouterUrlAsync: async () => surl };
    const wrapHandler = (h) => ({
      handleMessage(message) {
        const row = { t: since(), eventId: message.eventId, path: safePath(String(message.url ?? message.path ?? "")) };
        if (message.eventId === 107) {
          let payload = null;
          try { payload = decodeIncomingPayload(message.body); } catch (e) { row.decodeError = e.message; }
          row.peerMatched = !!payload && incomingPeerMatches(payload, PEER);
          if (!["answer", "serve"].includes(MODE) || (MODE !== "serve" && !row.peerMatched) || (gatedCallSeen && payload?.debugContent?.callId !== ownedIncomingId)) { row.gated = true; receipt.trouterEvents.push(row); return { isHandled: false, resultCode: 0 }; }
          // More than one SDK handler inspects event 107. Reserve only when one accepts it.
        }
        const d = h.handleMessage(message);
        row.handled = !!d?.isHandled; row.resultCode = d?.resultCode;
        if (message.eventId === 107 && d?.isHandled) { gatedCallSeen = true; try { ownedIncomingId = decodeIncomingPayload(message.body).debugContent?.callId; } catch {} }
        receipt.trouterEvents.push(row);
        if (d) return { isHandled: d.isHandled, resultCode: d.resultCode ?? 0, responseHeaders: d.responseHeaders, responseBody: d.responseBody };
      },
    });
    const stackTrouter = {
      start() {}, stop() {}, checkConnection() {},
      registerMessageHandler: (h) => service.registerMessageHandler(wrapHandler(h)),
      clearMessageHandlers: () => service.clearMessageHandlers(),
      state: () => 0, clientState: () => "Unknown", trouterUrl,
    };
    const skypeToken = async () => freshToken();
    const telemetry = { getCallingAdapter: () => ({ sendEvent() {}, sendEvents() {} }), sendEvents() {}, sendRealTimeEvents() {} };
    const context = vm.createContext(globals, { name: "teamsrelay-browserless-calling", codeGeneration: { strings: false, wasm: false } });
    globals.webpackChunk_msteams_react_web_client = [];
    new vm.Script(callingSource, { filename: "calling-pluginless.js", importModuleDynamically: async () => { throw new Error("dynamic import denied"); } }).runInContext(context);
    vm.runInContext(`
      globalThis.__factories = webpackChunk_msteams_react_web_client[0][1];
      globalThis.__cache = Object.create(null);
      globalThis.__require = function(id) {
        if (__cache[id]) return __cache[id].exports;
        if (!Object.hasOwn(__factories, id)) throw new Error('UNAPPROVED_FACTORY: ' + id);
        const module = { exports: {} }; __cache[id] = module;
        __factories[id](module, module.exports, __require); return module.exports;
      };
      __require.d = (e, d) => { for (const k of Object.keys(d)) Object.defineProperty(e, k, { enumerable: true, get: d[k] }); };
      __require.r = (e) => Object.defineProperty(e, '__esModule', { value: true });
      __require.o = (o, k) => Object.hasOwn(o, k);
      __require.n = (m) => { const g = m && m.__esModule ? () => m.default : () => m; __require.d(g, { a: g }); return g; };
      __require.g = globalThis;
      __require.e = () => Promise.reject(new Error('dynamic chunk denied'));
    `, context);
    const calling = vm.runInContext("__require(669989)", context);
    stage("calling-loaded", { version: (() => { try { return calling.pluginlessStackFactory.getVersion(); } catch { return null; } })() });
    const dispatcher = new calling.HttpRequestDispatcherImplementation(logger);
    const hostConfig = {
      logger, telemetryService: telemetry, trouterService: stackTrouter, platformType: "chrome", callSettings: {},
      signalingAgentConfig: {
        conversationServiceUrl: discovery.regionGtms.calling_conversationServiceUrl,
        trouterUrlGetter, logger, skypeToken, languageCode: "en-US",
        clientInformation: "SkypeSpaces/1415/26.1.0.0/os=windows; osVer=10; deviceType=computer; browser=chrome; browserVer=132.0.0.0",
        emergencyCallCountry: "", doHostlessCalling: true, shouldServiceSendCallEventMessages: true, shouldServiceSendNGCUpgradeMessages: false,
        supportsHostlessGroupCalls: true, isGVCOutgoingEnabled: true, isGVCJoiningEnabled: true, isWebRtcEnabled: true,
        httpRequestDispatcher: dispatcher, telemetryManager: telemetry.getCallingAdapter(), serverMuteUnmute: true, cloudScreenSharingFlag: "enabled",
        autoJoinOnConflict: true, supportsCompressedServicePayload: true, supportsSynchronousTrouterResponse: true,
        brokerEnabledOutgoing: false, brokerEnabledIncoming: false, brokerRequestBatching: false, brokerExclusively: false, handleNewOfferRequest: true,
      },
      mediaAgentFactoryConfig: {
        logger, safeLogger: logger, tokenProvider: skypeToken, telemetryAdapter: undefined,
        relayConfigProvider: async () => relayConfig, settings: {}, httpRequestDispatcher: dispatcher, detectH264Support: false,
        appStateProvider: { isOnline: () => true, changed: disposable, on: disposable, once: disposable },
        webcvProvider: undefined, websldProvider: undefined, wasmVqeProvider: undefined, createWasmWorkerCbs: undefined,
      },
    };
    stack = await calling.pluginlessStackFactory.build(hostConfig, false);
    stage("stack-built");
    registry = await stack.createCallRegistry({ id: `orgid:${BANDPEY_OID}`, displayName: process.env.CALLING_NAME ?? "TeamsRelay" });
    registry.on?.("tokenRequired", async (factorsJson, typeMask, metadataJson) => {
      let causeId;
      try { causeId = JSON.parse(metadataJson || "{}").causeId; } catch {}
      receipt.tokenRequests.push({ t: since(), typeMask, factors: safePath(String(factorsJson)).slice(0, 160) });
      if (typeMask & 1) registry.updateToken(factorsJson, { tokenType: 1 }, await freshToken(true), causeId, tokenExpiry);
      else registry.updateToken(factorsJson, { error: { code: 401, subCode: 0, phrase: "token type not available" } }, "", causeId);
    });
    const serviceUrls = Object.fromEntries(Object.entries(discovery.regionGtms).filter(([k]) => k.startsWith("calling_")));
    await registry.initialize(randomUUID(), { clientType: "enterprise", tenantId, region: discovery.region, partition: discovery.partition, serviceUrls });
    stage("registry-initialized", { serviceUrlKeys: Object.keys(serviceUrls).length });
    if (MODE !== "serve") await connectAudioHub();

    if (MODE === "serve") {
      let current = null, previous = -1, sinceCall = 0, caller = "", wasConnected = false;
      const recycleAt = Date.now() + 45 * 60_000;
      const watch = setInterval(() => {
        const c = current && current.state !== 7 ? current : (current ? null : (registry.calls ?? []).find(c => c.state !== 7));
        if (!c && !current && Date.now() >= recycleAt) process.kill(process.pid, "SIGTERM");
        if (c && c !== current) { current = c; sinceCall = Date.now(); caller = c.callerMri || "Incoming call"; previous = -1; wasConnected = false; }
        if (current) {
          wasConnected ||= current.state === 3;
          emit({ call: { caller, since: sinceCall, seen: Date.now(), ringing: current.state === 1, active: [2, 3].includes(current.state), ended: current.state === 7, answered: wasConnected, muted: !!current.isMuted } });
          if (current.state === 7 || (!c && previous !== -1)) { stopTone(); hubBridge?.close(); hubSocket?.close(); hubBridge = null; current = null; gatedCallSeen = false; ownedIncomingId = null; }
          else previous = current.state;
        }
      }, 500);
      let commandBusy = false;
      process.on("message", async message => {
        if (!message || typeof message !== "object" || message.tokenUpdated) return;
        if (commandBusy) { emit({ command: message.id, ok: false, error: "operation in progress" }); return; }
        commandBusy = true;
        try {
          if (message.op === "call") {
            if (current) throw new Error("call already active");
            assert(/^8:orgid:[a-f0-9-]{36}$/i.test(message.peer), "invalid peer");
            gatedCallSeen = true;
            current = await registry.createCallAsync({ type: "ThreadId", threadId: message.thread, callId: randomUUID(), localParticipantId: randomUUID(), causeId: randomUUID() });
            caller = message.name; sinceCall = Date.now(); previous = 0;
            await connectAudioHub(); startTone();
            // Participant completion can wait for the callee. Placing a call must return while it rings.
            const outgoing = current;
            void outgoing.addParticipant(message.peer).catch(e => {
              stackLog("error", `outgoing participant: ${scrub(e?.message ?? String(e))}`);
              if (outgoing === current && outgoing.state !== 7) void outgoing.stop(false).catch(() => undefined);
            });
            // start() resolves only once connected. Acknowledge placement when Teams reports connecting.
            const started = outgoing.start({ withVideo: false });
            started.catch(e => {
              stackLog("error", `outgoing start: ${scrub(e?.message ?? String(e))}`);
              if (outgoing === current && outgoing.state !== 7) void outgoing.stop(false).catch(() => undefined);
            });
            await new Promise((resolve, reject) => {
              const until = Date.now() + 20000;
              started.catch(reject);
              const check = () => {
                if ([2, 3].includes(outgoing.state)) resolve();
                else if (outgoing.state === 7) reject(new Error("outgoing call ended"));
                else if (Date.now() >= until) reject(new Error("outgoing call did not start"));
                else setTimeout(check, 50);
              };
              check();
            });
            emit({ command: message.id, ok: true }); return;
          }
          if (!current) throw new Error("no current call");
          if (message.op === "answer") { assert(message.since === sinceCall, "stale call"); await connectAudioHub(); startTone(); await current.accept({ withVideo: false }); }
          else if (message.op === "hangup") await current.stop(false);
          else if (message.op === "mute") { assert(typeof message.on === "boolean"); if (message.on && !current.isMuted) await current.mute(); else if (!message.on && current.isMuted) await current.unmute(); }
          else throw new Error("unknown command");
          emit({ command: message.id, ok: true });
        } catch(e) {
          if (["call", "answer"].includes(message.op)) {
            try { if (current && ![6,7].includes(current.state)) await current.stop(false); } catch {}
            stopTone(); hubBridge?.close(); hubSocket?.close();
          }
          emit({ command: message.id, ok: false, error: String(e?.message ?? e) });
        } finally { commandBusy = false; }
      });
      stage("worker-ready");
      await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); process.once("disconnect", resolve); });
      clearInterval(watch);
      answeredCall = current;
      return;
    }

    if (MODE === "init") {
      await new Promise((r) => setTimeout(r, 5000));
      stage("init-complete");
      return;
    }

    if (MODE === "echo") {
      const call = await registry.createCallAsync({ type: "ThreadId", threadId: "", callId: randomUUID(), localParticipantId: randomUUID(), causeId: randomUUID() });
      answeredCall = call;
      const callRow = { kind: "outgoing-echo", states: [] };
      receipt.calls.push(callRow);
      let lastState = -1;
      const stateWatch = setInterval(() => { if (call.state !== lastState) { lastState = call.state; callRow.states.push(`${since()}:${call.state}`); emit({ callState: call.state }); } }, 50);
      try {
        mark("call-created");
        startTone();
        call.addParticipant(ECHO_BOT).then(() => mark("bot-joined"), (e) => mark("bot-add-failed", { error: scrub(e?.message ?? JSON.stringify(e)).slice(0, 200) }));
        mark("start");
        await Promise.race([call.start({}), new Promise((_, reject) => setTimeout(() => reject(new Error("start did not complete within 40 s")), 40000))]);
        mark("started", { state: call.state });
        const startedAt = Date.now();
        const waitUntil = async (ms) => { while (Date.now() - startedAt < ms && call.state !== 7) await new Promise((r) => setTimeout(r, 100)); };
        // The bot plays a prompt, records a few seconds, plays them back. ECHO_MUTE=window keeps the call muted until
        // 25 s, over every recording window: the bot hears nothing, says so and hangs up. Otherwise a 4 s mute at 13 s.
        const muteWindow = process.env.ECHO_MUTE === "window";
        await waitUntil(muteWindow ? 300 : 13000);
        if (call.state !== 7) {
          await call.mute();
          mark("muted", { isMuted: call.isMuted });
          await waitUntil(muteWindow ? 25000 : 17000);
          if (call.state !== 7) {
            await call.unmute();
            mark("unmuted", { isMuted: call.isMuted });
          }
        }
        await waitUntil(TALK * 1000);
        if (call.state === 7) mark("remote-ended");
        if (call.state !== 7) {
          mark("stop-start");
          await call.stop(false);
          const endBy = Date.now() + 15000;
          while (call.state !== 7 && Date.now() < endBy) await new Promise((r) => setTimeout(r, 100));
        }
        mark("stopped", { state: call.state });
        assert.equal(call.state, 7, "echo call did not reach Disconnected");
      } finally {
        clearInterval(stateWatch);
        callRow.states.push(`${since()}:${call.state}`);
        callRow.terminatedReason = call.terminatedReason ?? null;
      }
      return;
    }

    // --- answer one owned call
    fs.writeFileSync(path.join(STATE, "listener-ready.json"), JSON.stringify({ at: Date.now(), seconds: LISTEN }), { mode: 0o600 });
    emit({ listenerReady: true, seconds: LISTEN });
    const until = Date.now() + LISTEN * 1000;
    let call = null;
    while (Date.now() < until && !call) {
      call = (registry.calls ?? [])[0] ?? null;
      if (!call) await new Promise((r) => setTimeout(r, 100));
    }
    if (!call) throw new Error("no owned call within the listen window");
    answeredCall = call;
    const callRow = { states: [] };
    receipt.calls.push(callRow);
    let lastState = -1;
    const stateWatch = setInterval(() => { if (call.state !== lastState) { lastState = call.state; callRow.states.push(`${since()}:${call.state}`); emit({ callState: call.state }); } }, 50);
    try {
      mark("call-added");
      const notifiedBy = Date.now() + 20000;
      while (call.state !== 1 && Date.now() < notifiedBy && call.state !== 7) await new Promise((r) => setTimeout(r, 50));
      assert.equal(call.state, 1, `call not Notified (state ${call.state})`);
      mark("notified");
      startTone();
      mark("accept-start");
      await Promise.race([call.accept({ withVideo: false }), new Promise((_, reject) => setTimeout(() => reject(new Error("accept did not complete within 30 s")), 30000))]);
      mark("accepted", { state: call.state });
      await new Promise((r) => setTimeout(r, TALK * 1000));
      mark("mute-start");
      await call.mute();
      mark("muted", { isMuted: call.isMuted });
      await new Promise((r) => setTimeout(r, 5000));
      await call.unmute();
      mark("unmuted", { isMuted: call.isMuted });
      await new Promise((r) => setTimeout(r, 5000));
      mark("stop-start");
      await call.stop(false);
      const endBy = Date.now() + 15000;
      while (call.state !== 7 && Date.now() < endBy) await new Promise((r) => setTimeout(r, 100));
      mark("stopped", { state: call.state });
      assert.equal(call.state, 7, "call did not reach Disconnected after local hang-up");
    } finally {
      clearInterval(stateWatch);
      callRow.states.push(`${since()}:${call.state}`);
    }
  } catch (e) {
    receipt.failure = scrub(e?.stack ?? e?.message ?? String(e)).slice(0, 1500);
    emit({ failure: scrub(e?.message ?? String(e)).slice(0, 300) });
  } finally {
    stopTone();
    if (hubBridge) { receipt.audioHub = { ...hubBridge.stats }; hubBridge.close(); hubSocket?.close(); }
    if (answeredCall && ![6, 7].includes(answeredCall.state)) {
      try { await Promise.race([answeredCall.stop(false), new Promise((r) => setTimeout(r, 8000))]); receipt.cleanupStoppedCall = true; } catch (e) { receipt.cleanupStopError = String(e?.message ?? e).slice(0, 200); }
    }
    closeWindow();
    try { await Promise.race([registry?.dispose?.(), new Promise((r) => setTimeout(r, 3000))]); } catch {}
    try { await Promise.race([stack?.dispose?.(), new Promise((r) => setTimeout(r, 3000))]); } catch {}
    try {
      await writes.close(() => service.stop(true), async () => {
        if (registrationAttempted) {
          const response = await trouterFetch(new Request(`${routes.registrar}/${endpoint}`, { method: "DELETE", headers: { "X-Skypetoken": token, "X-MS-Migration": "True", Accept: "application/json" } }));
          assert(response.ok || response.status === 404, "owned registration cleanup failed");
        }
      });
      receipt.ownedRegistrationRemoved = true;
      fs.unlinkSync(ownership);
    } catch (e) { receipt.ownedRegistrationRemoved = false; receipt.failure = `${receipt.failure ? receipt.failure + "; " : ""}cleanup: ${e.message}`; }
    for (const s of sockets) { try { s.close(); } catch {} }
    trouterRuntime.dispose();
    for (const sink of sinks) { try { sink.ondata = null; sink.stop(); } catch {} }
    for (const t of micTracks) { try { t.stop(); } catch {} }
    for (const pc of nativePeers) { try { pc.close(); } catch {} }
    for (const id of [...realTimers.keys()]) clearVmTimer(id);
    fs.rmSync(path.join(STATE, "listener-ready.json"), { force: true });
    cleanupDone = true;
    receipt.registered = registrarSucceeded(trouterRequests, routes);
    receipt.trouterRequests = trouterRequests;
    receipt.capture = captureLog;
    receipt.audioGraph = audioGraph;
    receipt.audio = { micFramesFed: micFrames, heardFrames: heard.frames, heardSampleRate: heard.sampleRate, heardChannels: heard.channels, windows: heard.windows };
    receipt.peerConnectionsClosed = nativePeers.every((pc) => pc.signalingState === "closed");
    receipt.cleanupDone = cleanupDone;
    receipt.endedAt = new Date().toISOString();
    fs.writeFileSync(path.join(STATE, "host-receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    fs.closeSync(logFile);
    emit({ final: true, failure: receipt.failure ? receipt.failure.split("\n")[0].slice(0, 300) : null, ownedRegistrationRemoved: receipt.ownedRegistrationRemoved, stages: receipt.stages.map((s) => s.name), heardFrames: heard.frames, denied: receipt.denied.length, requests: receipt.requests.length });
  }
}

main().then(
  () => process.stdout.write("", () => process.exit(receipt.failure ? 1 : 0)),
  (e) => { process.stderr.write(scrub(e?.stack ?? e) + "\n"); process.stdout.write("", () => process.exit(2)); },
);
