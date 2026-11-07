import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { inflateSync } from "node:zlib";

const SHA256 = "ae686dad9c49f198dc2fe41bdd68a78ca29e38b1c070f3d708fd1ea08aeabae8";
const MAX_PAYLOAD = 1024 * 1024;
const blocked = (what) => () => { throw new Error(`offline ${what} blocked`); };

export function loadTrouterBundle(source, fetch = blocked("fetch"), WebSocket = class { constructor() { throw new Error("offline WebSocket blocked"); } }) {
  const timers = new Set();
  const schedule = (fn, ms, ...args) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(...args); }, ms);
    timers.add(timer);
    return timer;
  };
  const repeat = (fn, ms, ...args) => {
    const timer = setInterval(fn, ms, ...args);
    timers.add(timer);
    return timer;
  };
  const cancel = (timer) => { clearTimeout(timer); clearInterval(timer); timers.delete(timer); };
  const context = vm.createContext({
    URL, Request, Headers, Response, TextEncoder, TextDecoder, fetch,
    location: new URL("https://teams.cloud.microsoft/"),
    WebSocket,
    setTimeout: schedule, clearTimeout: cancel, setInterval: repeat, clearInterval: cancel,
    console: { log() {}, info() {}, warn() {}, error() {} },
  }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(source, context, { timeout: 1000, filename: "cmd-trouter.js" });
  const chunks = context.webpackChunk_msteams_react_web_client;
  assert(chunks?.length === 1, "one Trouter chunk required");
  const factories = chunks[0][1];
  assert.deepEqual(Object.keys(factories).sort(), ["161789", "704853"], "only the two Trouter factories are allowed");
  const cache = new Map();
  const require = (id) => {
    assert(Object.hasOwn(factories, id), "unavailable module requested");
    if (!cache.has(id)) {
      const entry = { exports: {} };
      cache.set(id, entry);
      factories[id](entry, entry.exports, require);
    }
    return cache.get(id).exports;
  };
  require.d = (exports, getters) => {
    for (const [name, get] of Object.entries(getters)) Object.defineProperty(exports, name, { enumerable: true, get });
  };
  require.r = (exports) => Object.defineProperty(exports, "__esModule", { value: true });
  require.nmd = (module) => (module.paths = [], module.children ??= [], module);
  require.g = context;
  require.o = (object, key) => Object.hasOwn(object, key);
  try {
    return { api: require(704853), registrar: require(161789), dispose: () => { for (const timer of timers) cancel(timer); } };
  } catch (e) {
    for (const timer of timers) cancel(timer);
    throw e;
  }
}

export function decodeIncomingPayload(body) {
  if (body.gp && typeof body.gp === "object") return body.gp;
  const source = typeof body.gp === "string" ? body.gp : body.cp;
  assert(typeof source === "string" && source.length <= Math.ceil(MAX_PAYLOAD * 4 / 3), "missing or oversized incoming payload");
  const bytes = Buffer.from(source, "base64");
  const decoded = typeof body.gp === "string" ? bytes : inflateSync(bytes, { maxOutputLength: MAX_PAYLOAD });
  assert(decoded.length <= MAX_PAYLOAD, "oversized incoming payload");
  return JSON.parse(decoded.toString("utf8"));
}

async function main() {
  const bytes = fs.readFileSync(process.argv[2]);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA256, "Trouter artifact digest mismatch");
  const writes = [];
  const tokenRequests = [];
  const logs = [];
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      assert.equal(new URL(url).hostname, "trouter.invalid", "unexpected offline WebSocket host");
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.({});
        this.onmessage?.({ data: "1::" });
      });
    }
    send(data) {
      this.sent.push(data);
      if (String(data).includes('"user.authenticate"')) {
        const connected = { surl: "https://trouter.invalid/synthetic", connectparams: { se: Date.now() + 86400_000 }, ttl: 3600, id: "offline-connection", ccid: "offline-client", reconnectUrl: "wss://trouter.invalid/v4/c" };
        queueMicrotask(() => this.onmessage?.({ data: `5:::${JSON.stringify({ name: "trouter.connected", args: [connected] })}` }));
      }
    }
    close() { this.readyState = 3; this.onclose?.({}); }
  }
  const logger = Object.fromEntries(["debug", "info", "warn", "error"].map((key) => [key, (text) => logs.push(text)]));
  const runtime = loadTrouterBundle(bytes.toString("utf8"), async (request) => {
    assert(request.url === "https://registrar.invalid/registrations" || request.url === "https://registrar.invalid/registrations/isolated-endpoint", "unexpected offline request");
    writes.push({ method: request.method, path: new URL(request.url).pathname, body: request.method === "POST" ? await request.json() : null, bearerApplied: request.headers.get("Authorization") === "Bearer synthetic-token" });
    return Response.json({});
  }, FakeWebSocket);
  try {
    const client = runtime.registrar.l(logger, async (request) => {
      tokenRequests.push({ purpose: request.purpose, supportedTokenTypes: [...request.supportedTokenTypes] });
      return { token: "synthetic-token", tokenType: "aad" };
    }, { registrarUrl: "https://registrar.invalid/registrations", registrationId: "isolated-endpoint", requestTimeoutMs: 100, initialRetryDelayMs: 1, maxRetryDelayMs: 1, maxRetriesForGetToken: 0, usingLegacyTokenApi: false });
    const description = { appId: "SkypeSpacesWeb", aesKey: "", languageId: "en-US", platform: "browser", templateKey: "SkypeSpacesWeb_2.6", platformUIVersion: "offline-spike" };
    const transports = { TROUTER: [{ context: "", path: "https://trouter.invalid/synthetic", ttl: 3600 }] };
    await client.register(description, transports);
    await client.unregister();
    assert(writes[0].method === "POST" && writes[1].method === "DELETE");
    assert.deepEqual(writes[0].body, { clientDescription: description, registrationId: "isolated-endpoint", nodeId: "", transports });
    assert(writes.every((r) => r.bearerApplied));
    assert(tokenRequests.every((r) => r.purpose === "registrar" && r.supportedTokenTypes.includes("aad")));
    const service = runtime.api.createTrouterService(logger);
    let incoming;
    let replies = 0;
    service.registerMessageHandler({ handleMessage: (message) => {
      if (message.eventId !== 107) return { isHandled: false };
      incoming = decodeIncomingPayload(message.body);
      return { isHandled: true, resultCode: 200 };
    } });
    const synthetic = { callNotification: { from: { id: "8:orgid:synthetic-peer" } }, debugContent: { callId: "synthetic-call" } };
    const response = { status: 0, send: () => { replies++; } };
    assert(service.tryMessageHandlers({ body: JSON.stringify({ evt: 107, gp: Buffer.from(JSON.stringify(synthetic)).toString("base64") }), path: "/calling", headers: {} }, response));
    assert.deepEqual(incoming, synthetic);
    assert(response.status === 200 && replies === 1);
    assert(service.tryMessageHandlers({ body: JSON.stringify({ eventId: 107, gp: synthetic }), path: "/calling", headers: {} }, response));
    service.clearMessageHandlers();
    assert(!service.tryMessageHandlers({ body: "{}", path: "/calling", headers: {} }, response));
    service.stop();
    const transport = runtime.api.createTrouterService(logger);
    let socketIncoming;
    transport.registerMessageHandler({ handleMessage: (message) => {
      if (message.eventId !== 107) return { isHandled: false };
      socketIncoming = decodeIncomingPayload(message.body);
      return { isHandled: true, resultCode: 200 };
    } });
    try {
      transport.start({ authTokenProvider: async () => ({ token: "synthetic-token", tokenType: "aad" }), trouterSettings: { productName: "SkypeSpaces", version: "offline", registrationId: "isolated-endpoint", trouterServiceUrl: "wss://trouter.invalid/v4/a", registrarServiceUrl: "https://registrar.invalid/registrations", platform: "browser", pnhAppId: "SkypeSpacesWeb", pnhTemplate: "SkypeSpacesWeb_2.6", pnhContext: "", maxRegistrationTimeInMs: 3600_000, initialConnectivityCheck: false, trouterConnectTimeoutInMs: 1000 }, telemetryConfig: { settings: {}, eventLogger: { logEvent() {} } } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert(sockets.length === 1 && sockets[0].sent.some((message) => String(message).includes('"user.authenticate"')), "synthetic transport did not authenticate");
      assert(writes.length >= 3 && writes[2].method === "POST", "synthetic connected response did not register");
      const request = { id: 17, method: "POST", url: "/synthetic/calling", headers: {}, body: JSON.stringify({ evt: 107, gp: Buffer.from(JSON.stringify(synthetic)).toString("base64") }) };
      sockets[0].onmessage({ data: `3:::${JSON.stringify(request)}` });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(socketIncoming, synthetic, "socket event did not reach the incoming handler");
      assert(sockets[0].sent.some((packet) => String(packet).includes('"id":17') && String(packet).includes('"status":200')), "no transport response for incoming event");
    } catch (e) {
      console.error(JSON.stringify({ phase: "synthetic-transport", logs: logs.slice(-12), error: e.message }));
      throw e;
    } finally { transport.stop(); }
    console.log(JSON.stringify({ artifactSha256: SHA256, version: runtime.api.getTrouterServiceVersion(), loadedInNodeWithoutBrowser: true, syntheticRegistrationBodyMatched: true, syntheticUnregister: true, syntheticIncoming107Decoded: true, transportResponse200: true, realNetworkRequests: 0, realEndpointsRegistered: 0, callsCreated: 0, mediaTested: false, syntheticTransportConnected: true }));
  } finally {
    runtime.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
