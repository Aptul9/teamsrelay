import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadTrouterBundle, decodeIncomingPayload } from "./trouter-offline-probe.mjs";

const SHA256 = "ae686dad9c49f198dc2fe41bdd68a78ca29e38b1c070f3d708fd1ea08aeabae8";
const trouterHost = (host) => /^(?:[a-z0-9-]+\.)*trouter\.teams\.microsoft\.com$/i.test(host);
const clean = (url) => !url.username && !url.password && !url.port && !url.search && !url.hash;

export function callingRoutes(discovery) {
  const trouter = new URL(discovery.regionGtms.calling_trouterUrl);
  const registrar = new URL(discovery.regionGtms.calling_registrarUrl);
  assert(trouter.protocol === "https:" && clean(trouter) && trouterHost(trouter.hostname) && /^\/v[34]\/[ac]$/.test(trouter.pathname), "unexpected calling Trouter route");
  assert(registrar.protocol === "https:" && clean(registrar) && registrar.hostname === "teams.microsoft.com" && /^\/registrar\/prod\/v2\/registrations$/i.test(registrar.pathname), "unexpected calling registrar route");
  trouter.pathname = "/v4/a";
  return { trouter: trouter.href, registrar: registrar.href };
}

export function permittedCallingRequest(value, method, routes, endpoint) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port || url.hash) return false;
    const registrar = new URL(routes.registrar);
    if (url.protocol === "https:" && url.origin === registrar.origin && !url.search) {
      if (method === "POST" && url.pathname === registrar.pathname) return true;
      if (method === "DELETE" && url.pathname === `${registrar.pathname}/${endpoint}`) return true;
    }
    if (!trouterHost(url.hostname)) return false;
    if (method === "WEBSOCKET") return url.protocol === "wss:" && (url.pathname === "/v4/c" || /^\/socket\.io\/1\/websocket\//.test(url.pathname));
    return url.protocol === "https:" && ((method === "POST" && url.pathname === "/v4/a") || (method === "GET" && ["/v4/a", "/v4/c"].includes(url.pathname)));
  } catch { return false; }
}

export function listenerSeconds(value) {
  if (value === undefined) return 0;
  assert(/^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 120, "listener duration must be 1-120 seconds");
  return Number(value);
}

export function incomingPeerMatches(payload, peer) {
  const from = payload.callNotification?.from?.id;
  return typeof from === "string" && !!peer && [peer, peer.slice(2), peer.slice("8:orgid:".length)].includes(from.toLowerCase());
}

export function trouterSettings(routes, endpoint, version) {
  return { productName: "SkypeSpaces", version, registrationId: endpoint, trouterServiceUrl: routes.trouter, registrarServiceUrl: routes.registrar, platform: "Chrome", pnhAppId: "SkypeSpacesWeb", pnhTemplate: "SkypeSpacesWeb_2.6", pnhContext: "", maxRegistrationTimeInMs: 3600_000, initialConnectivityCheck: false, trouterConnectTimeoutInMs: 10000, retryLimitOnTokenFetch: 0 };
}

export function reserveRegistration(file, owned) {
  fs.writeFileSync(file, JSON.stringify(owned), { mode: 0o600, flag: "wx" });
}

export function registrarSucceeded(requests, routes) {
  const url = new URL(routes.registrar);
  return requests.some((r) => r.method === "POST" && r.host === url.hostname && r.path === url.pathname && r.status >= 200 && r.status < 300);
}

export function registrationWrites() {
  const pending = new Set();
  let closed = false;
  let uncertain = false;
  return {
    send(write) {
      assert(!closed, "registration writes closed");
      const task = (async () => {
        try { return await write(); }
        catch (e) { uncertain = true; throw e; }
      })();
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    },
    async close(stop, remove) {
      closed = true;
      await Promise.allSettled([...pending]);
      stop();
      assert(!uncertain, "registration outcome uncertain; ownership retained");
      await remove();
    },
  };
}

async function main() {
  assert(process.argv.includes("--register-bandpey") || process.argv.includes("--cleanup-owned"), "explicit isolated Bandpey action flag required");
  const dir = fs.realpathSync(process.argv[2]);
  assert(dir === "/tmp/teamsrelay-calling-20261107/7", "only the isolated Bandpey directory is allowed");
  const listen = listenerSeconds(process.argv.find((arg) => arg.startsWith("--listen-seconds="))?.slice("--listen-seconds=".length));
  const peer = process.argv.find((arg) => arg.startsWith("--peer-mri="))?.slice("--peer-mri=".length).toLowerCase();
  if (listen) assert(/^8:orgid:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(peer ?? ""), "an identified owner-controlled peer is required before listening");
  const discoveryFile = path.join(dir, "discovery.json");
  if (!process.argv.includes("--cleanup-owned")) assert(Date.now() - fs.statSync(discoveryFile).mtimeMs < 10 * 60_000, "fresh discovery required");
  const discovery = JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
  const routes = callingRoutes(discovery);
  const token = discovery.tokens?.skypeToken;
  assert(typeof token === "string" && token.length > 100, "no discovered Skype token");
  const ownership = path.join(dir, "owned-registration.json");
  if (process.argv.includes("--cleanup-owned")) {
    const owned = JSON.parse(fs.readFileSync(ownership, "utf8"));
    assert.equal(owned.registrar, routes.registrar, "owned registrar changed");
    assert(/^[a-f0-9-]{36}$/.test(owned.endpoint), "invalid owned endpoint");
    const url = `${routes.registrar}/${owned.endpoint}`;
    assert(permittedCallingRequest(url, "DELETE", routes, owned.endpoint));
    const response = await fetch(url, { method: "DELETE", headers: { "X-Skypetoken": token, "X-MS-Migration": "True", Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
    console.log(JSON.stringify({ ownedCleanupHttp: response.status }));
    assert(response.ok || response.status === 404, "owned registration cleanup failed");
    fs.unlinkSync(ownership);
    return;
  }
  const bundle = fs.readFileSync(process.argv[3]);
  assert.equal(createHash("sha256").update(bundle).digest("hex"), SHA256, "Trouter digest mismatch");
  const endpoint = randomUUID();
  reserveRegistration(ownership, { endpoint, registrar: routes.registrar });
  const requests = [];
  const sockets = [];
  const tokenRequests = [];
  const events = [];
  const socketFrames = {};
  const socketEvents = {};
  const logCounts = { debug: 0, info: 0, warn: 0, error: 0 };
  const logger = Object.fromEntries(Object.keys(logCounts).map((name) => [name, () => { logCounts[name]++; }]));
  let registrationAttempted = false;
  let ownedRegistrationRemoved = false;
  const writes = registrationWrites();
  let resolveRegistered;
  const registered = new Promise((resolve) => { resolveRegistered = resolve; });
  let resolveIncoming;
  const incoming = new Promise((resolve) => { resolveIncoming = resolve; });
  const request = async (input) => {
    const req = input instanceof Request ? input : new Request(input);
    assert(permittedCallingRequest(req.url, req.method, routes, endpoint), "unexpected network request blocked");
    const url = new URL(req.url);
    const isRegistration = req.method === "POST" && url.href === routes.registrar;
    if (isRegistration) {
      const body = await req.clone().json();
      assert.equal(body.registrationId, endpoint, "attempted to register another endpoint");
    }
    const perform = () => fetch(req, { redirect: "manual", signal: AbortSignal.any([req.signal, AbortSignal.timeout(15000)]) });
    const response = isRegistration ? await writes.send(() => { registrationAttempted = true; return perform(); }) : await perform();
    const challenge = response.headers.get("www-authenticate");
    requests.push({ method: req.method, host: url.hostname, path: url.pathname.startsWith(new URL(routes.registrar).pathname) ? new URL(routes.registrar).pathname + (req.method === "DELETE" ? "/<owned-endpoint>" : "") : url.pathname, status: response.status, requestedTokenTypes: challenge ? ["skype", "aad", "cae"].filter((type) => new RegExp(`\\b${type}\\b`, "i").test(challenge)) : [] });
    if (req.method === "POST" && url.href === routes.registrar && response.ok) resolveRegistered();
    return response;
  };
  class GuardedWebSocket extends WebSocket {
    constructor(url) {
      assert(permittedCallingRequest(url, "WEBSOCKET", routes, endpoint), "unexpected WebSocket blocked");
      super(url);
      sockets.push(this);
      this.addEventListener("message", ({ data }) => {
        if (typeof data !== "string") return;
        const type = data.split(":", 1)[0];
        if (/^\d+$/.test(type)) socketFrames[type] = (socketFrames[type] ?? 0) + 1;
        if (data.startsWith("5:::")) {
          try {
            const name = JSON.parse(data.slice(4)).name;
            if (/^[a-z._]{1,80}$/i.test(name)) socketEvents[name] = (socketEvents[name] ?? 0) + 1;
          } catch { /* malformed event remains visible through the frame count */ }
        }
      });
    }
  }
  const runtime = loadTrouterBundle(bundle.toString("utf8"), request, GuardedWebSocket);
  const service = runtime.api.createTrouterService(logger);
  let connected = false;
  let failure;
  let deadline;
  service.registerMessageHandler({ handleMessage: (message) => {
    if (![107, 109, 111, 119, 125, 126].includes(message.eventId)) {
      events.push({ eventId: message.eventId, inspected: false });
      return { isHandled: false };
    }
    const payload = decodeIncomingPayload(message.body);
    const expectedPeerMatched = incomingPeerMatches(payload, peer);
    events.push({ eventId: message.eventId, hasCallNotification: !!payload.callNotification, hasCallId: !!payload.debugContent?.callId, expectedPeerMatched });
    if (listen && message.eventId === 107 && expectedPeerMatched) {
      fs.writeFileSync(path.join(dir, "owned-incoming.json"), JSON.stringify(payload), { mode: 0o600 });
      resolveIncoming();
    }
    return { isHandled: true, resultCode: 200 };
  } });
  try {
    service.start({
      authTokenProvider: async (params) => {
        tokenRequests.push({ purpose: params.purpose, needFresh: !!params.needFresh, supportedTokenTypes: [...params.supportedTokenTypes] });
        assert(!params.needFresh && params.supportedTokenTypes.includes("skype"), "fresh or different calling token required");
        return { token, tokenType: "skype" };
      },
      trouterSettings: trouterSettings(routes, endpoint, runtime.api.getTrouterServiceVersion()),
      telemetryConfig: { settings: {}, eventLogger: { logEvent() {} } },
    });
    const linked = service.getTrouterUrlAsync().then(() => { connected = true; });
    await Promise.race([Promise.all([linked, registered]), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("calling registration did not complete within 25 seconds")), 25000); })]);
    clearTimeout(deadline);
    if (listen) {
      console.log(JSON.stringify({ slot: 7, listenerReady: true, seconds: listen, ownerControlledPeerRequired: true, callAcknowledgementEnabled: false }));
      fs.writeFileSync(path.join(dir, "listener-ready.json"), JSON.stringify({ at: Date.now(), seconds: listen }), { mode: 0o600 });
      await Promise.race([incoming, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("no matching incoming event during the requested window")), listen * 1000); })]);
      clearTimeout(deadline);
    }
  } catch (e) { failure = e.message; }
  finally {
    clearTimeout(deadline);
    try {
      await writes.close(() => service.stop(true), async () => {
        // Trouter stop(true) skips its automatic unregister; terminal DELETE follows drained writes.
        if (registrationAttempted) {
          const response = await request(new Request(`${routes.registrar}/${endpoint}`, { method: "DELETE", headers: { "X-Skypetoken": token, "X-MS-Migration": "True", Accept: "application/json" } }));
          assert(response.ok || response.status === 404, "owned registration cleanup failed");
        }
      });
      ownedRegistrationRemoved = true;
    } catch (e) { failure = `${failure ? failure + "; " : ""}owned registration cleanup failed: ${e.message}`; }
    finally {
      for (const socket of sockets) socket.close();
      runtime.dispose();
      fs.rmSync(path.join(dir, "listener-ready.json"), { force: true });
    }
  }
  const receipt = { slot: 7, connectedWithoutBrowser: connected, registered: registrarSucceeded(requests, routes), ownedRegistrationRemoved, socketCount: sockets.length, socketFrames, socketEvents, tokenRequests, incomingEvents: events, requests, logCounts, failure, liveAccountModeChanged: false, callsAnswered: 0, mediaTested: false };
  fs.writeFileSync(path.join(dir, "registration-receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  if (receipt.ownedRegistrationRemoved) fs.unlinkSync(ownership);
  console.log(JSON.stringify(receipt));
  assert(!failure, failure);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
