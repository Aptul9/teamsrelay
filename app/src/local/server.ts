import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { nowSeconds } from "@/agent/context";
import { errorText, log } from "@/agent/log";
import type { SlotStore } from "@/agent/store/slot-store";
import { sleep } from "@/agent/teams/page";
import { chatName, commandOf } from "@/shared/command-input";
import { bearerToken, sameToken } from "@/shared/bearer";
import { HttpError } from "@/shared/http-error";
import { COMMAND_KEY, IMAGE_TYPES, type CommandStatus, type ImageExt } from "@/shared/slot-db/commands";
import { MEDIA_NAME, type Message } from "@/shared/slot-db/rows";
import { AgentHealth, healthOf, Identity, parseState, STATE, type SlotHealth } from "@/shared/slot-db/state";
import type { RelayDevices } from "./devices";

// The only way into the relay: the app (src/local/web) and a small API behind one token. Everything the phone asks
// for is a row of relay.db, or a command the agent runs on Teams. No browser, no desktop, nothing of the Microsoft
// session goes out through here.

export type ApiOptions = {
  store: SlotStore;
  devices: RelayDevices;
  token: string;
  // VAPID public key the devices subscribe with, "" when push is off
  vapidKey: string;
  // the page of the app, and the files it shares with the web app (service worker, manifest, icons)
  webDir: string;
  publicDir: string;
  mediaDir: string;
  // how long POST /api/cmd waits for the outcome before answering pending
  commandWaitMs?: number;
};

// The files of the app, and nothing else from the disk
const STATIC: Record<string, { dir: "web" | "public"; file: string; type: string }> = {
  "/": { dir: "web", file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { dir: "web", file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { dir: "web", file: "app.css", type: "text/css; charset=utf-8" },
  "/sw.js": { dir: "public", file: "sw.js", type: "text/javascript; charset=utf-8" },
  "/manifest.webmanifest": { dir: "public", file: "manifest.webmanifest", type: "application/manifest+json" },
  "/static/icon-180.png": { dir: "public", file: "static/icon-180.png", type: "image/png" },
  "/static/icon-192.png": { dir: "public", file: "static/icon-192.png", type: "image/png" },
  "/static/icon-512.png": { dir: "public", file: "static/icon-512.png", type: "image/png" },
};

// The files of the app on disk, for the check of the bundle
export const appFiles = (webDir: string, publicDir: string) => Object.values(STATIC).map((f) => path.join(f.dir === "web" ? webDir : publicDir, f.file));

// The page loads only what the relay serves; messages are shown as text, never as HTML
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// Wrong tokens from one address: after `limit` within the window, the wrong ones get 429 until the window ends, and
// are no longer logged. The token has 192 bits: this only keeps a scanner from filling the log. The right token is
// never limited: behind a proxy on the same machine (tailscale serve) every phone has the address of the proxy.
export class Failures {
  private readonly seen = new Map<string, { n: number; first: number }>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 600_000,
    private readonly clock: () => number = Date.now,
  ) {}

  blocked(ip: string): boolean {
    return (this.current(ip)?.n ?? 0) >= this.limit;
  }

  add(ip: string) {
    const f = this.current(ip) ?? { n: 0, first: this.clock() };
    f.n++;
    this.seen.set(ip, f);
  }

  private current(ip: string) {
    const f = this.seen.get(ip);
    if (f && this.clock() - f.first > this.windowMs) {
      this.seen.delete(ip);
      return undefined;
    }
    return f;
  }
}

// The key the app gives a command, or null: the same key queues it once (a retry after a lost answer)
function keyOf(b: Record<string, unknown>): string | null {
  if (b.key === undefined || b.key === null) return null;
  if (typeof b.key !== "string" || !COMMAND_KEY.test(b.key)) throw new HttpError(400, "Invalid command key");
  return b.key;
}

// Why a command cannot run now, as the status and message the app shows; null when it can
function refusal(h: SlotHealth): HttpError | null {
  if (h.agent !== "ok") return new HttpError(503, "The relay is not reading Teams right now: see its log");
  if (h.browser === "down") return new HttpError(503, "The browser of the relay does not start: see its log");
  if (h.teams === "login") return new HttpError(409, "Teams is signed out: sign in again in the relay window");
  return null;
}

// A Web Push subscription as the browser gives it (PushSubscription.toJSON())
function subscriptionOf(b: Record<string, unknown>): { endpoint: string; json: string } {
  const { endpoint, keys } = b as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://") || endpoint.length > 2000) throw new HttpError(400, "Invalid subscription endpoint");
  const b64 = /^[A-Za-z0-9_-]{16,200}=*$/;
  if (typeof keys?.p256dh !== "string" || typeof keys.auth !== "string" || !b64.test(keys.p256dh) || !b64.test(keys.auth)) {
    throw new HttpError(400, "Invalid subscription keys");
  }
  return { endpoint, json: JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }) };
}

// What the app shows of a message: text only (the reduced HTML stays in the database)
function shownMessage(m: Message) {
  return {
    mid: m.mid,
    author: m.author,
    text: m.text,
    mine: !!m.mine,
    quote: m.quote ?? null,
    images: (m.images ?? []).map((i) => (i.f ? { f: i.f, w: i.w ?? 0, h: i.h ?? 0 } : { url: i.url ?? "", w: i.w ?? 0, h: i.h ?? 0 })),
    files: m.files ?? [],
    reactions: m.reactions ?? [],
    status: m.status ?? "",
    edited: !!m.edited,
    deleted: !!m.deleted,
    mentionsMe: !!m.mentionsMe,
  };
}

async function readJson(req: http.IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "JSON body expected");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "Body too large");
    chunks.push(chunk as Buffer);
  }
  let v: unknown;
  try {
    v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "JSON object expected");
  return v as Record<string, unknown>;
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

// The outcome of the command, or where it is (pending, running) when it takes longer than `ms`
async function waitFor(store: SlotStore, id: number, ms: number): Promise<CommandStatus> {
  const end = Date.now() + ms;
  for (;;) {
    const status = store.commandStatus(id) ?? "failed";
    if ((status !== "pending" && status !== "running") || Date.now() >= end) return status;
    await sleep(200);
  }
}

export function apiHandler(o: ApiOptions, failures = new Failures()): http.RequestListener {
  const wait = o.commandWaitMs ?? 30_000;

  const health = () => healthOf(parseState(AgentHealth.partial(), o.store.getState(STATE.health), {}));

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/state") {
      const me = parseState(Identity, o.store.getState(STATE.me));
      return send(res, 200, {
        health: health(),
        me: { name: me.name, email: me.email, tenant: me.tenant },
        chats: o.store.chats().map(({ name, preview, time, unread, mention, muted }) => ({ name, preview, time, unread, mention, muted })),
        active: o.store.getState(STATE.activeChat),
        devices: o.devices.count(),
        push: !!o.vapidKey,
      });
    }
    if (route === "GET /api/messages") {
      const chat = chatName(url.searchParams.get("chat"));
      const open = chat === o.store.getState(STATE.activeChat);
      // the app shows the chat Teams has open: Teams keeps it while the app looks at it, then goes back to the self chat
      if (open) o.store.setState(STATE.viewing, JSON.stringify({ chat, ts: nowSeconds() }));
      return send(res, 200, { chat, open, messages: o.store.messages(chat).map(shownMessage) });
    }
    if (route === "POST /api/cmd") {
      const b = await readJson(req);
      const cmd = commandOf(b);
      const key = keyOf(b);
      // sent again after a lost answer: the command queued the first time, whatever the state of Teams now
      const known = key ? o.store.commandIdByKey(key) : null;
      if (known) return send(res, 200, { id: known, status: await waitFor(o.store, known, wait) });
      const refused = refusal(health());
      if (refused) throw refused;
      const id = o.store.enqueue(cmd.type, cmd.arg1, cmd.arg2, key);
      return send(res, 200, { id, status: await waitFor(o.store, id, wait) });
    }
    const cmdId = req.method === "GET" && /^\/api\/cmd\/(\d{1,12})$/.exec(url.pathname);
    if (cmdId) {
      const status = o.store.commandStatus(Number(cmdId[1]));
      if (!status) throw new HttpError(404, "No such command");
      return send(res, 200, { id: Number(cmdId[1]), status });
    }
    if (route === "POST /api/push") {
      const { endpoint, json } = subscriptionOf(await readJson(req));
      o.devices.save(endpoint, json, String(req.headers["user-agent"] ?? "").slice(0, 200));
      log.info("push", "device subscribed", { devices: o.devices.count() });
      return send(res, 200, { ok: true, devices: o.devices.count() });
    }
    if (route === "DELETE /api/push") {
      const b = await readJson(req);
      if (typeof b.endpoint !== "string") throw new HttpError(400, "Invalid subscription endpoint");
      o.devices.remove(b.endpoint);
      return send(res, 200, { ok: true, devices: o.devices.count() });
    }
    const media = req.method === "GET" && /^\/media\/([^/]+)$/.exec(url.pathname);
    const name = media ? MEDIA_NAME.exec(media[1]) : null;
    if (name) {
      const file = path.join(o.mediaDir, name[0]);
      if (!fs.existsSync(file)) throw new HttpError(404, "Not found");
      res.writeHead(200, { "Content-Type": IMAGE_TYPES[name[1] as ImageExt], "Cache-Control": "private, max-age=86400" });
      res.end(fs.readFileSync(file));
      return;
    }
    throw new HttpError(404, "Not found");
  }

  return (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    const ip = req.socket.remoteAddress ?? "";
    let where = "";
    // everything inside: whatever a request carries ends as an answer, never as an error that stops the relay
    (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://relay");
      } catch {
        throw new HttpError(400, "Invalid request target");
      }
      where = url.pathname;
      const page = req.method === "GET" ? STATIC[url.pathname] : undefined;
      if (page) {
        res.writeHead(200, { "Content-Type": page.type, "Cache-Control": "no-cache", ...(page.file === "index.html" ? { "Content-Security-Policy": CSP } : {}) });
        res.end(fs.readFileSync(path.join(page.dir === "web" ? o.webDir : o.publicDir, page.file)));
        return;
      }
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
      // the public key is public: the app needs it to subscribe
      if (req.method === "GET" && url.pathname === "/api/vapid") return send(res, 200, { key: o.vapidKey });
      if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/media/")) throw new HttpError(404, "Not found");
      if (!sameToken(bearerToken(req.headers.authorization), o.token)) {
        if (failures.blocked(ip)) throw new HttpError(429, "Too many wrong tokens: try again later");
        failures.add(ip);
        log.warn("api", "wrong token", { ip, path: url.pathname });
        throw new HttpError(401, "Wrong token");
      }
      await api(req, res, url);
    })().catch((e: unknown) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return send(res, e.status, { detail: e.message });
      log.warn("api", errorText(e), { path: where });
      send(res, 500, { detail: "Internal error" });
    });
  };
}

export type RunningServer = { url: string; close(): Promise<void> };

export async function startServer(o: ApiOptions & { bind: string; port: number; tls: { cert: string; key: string } | null }): Promise<RunningServer> {
  const handler = apiHandler(o);
  const server = o.tls ? https.createServer({ cert: fs.readFileSync(o.tls.cert), key: fs.readFileSync(o.tls.key) }, handler) : http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.bind, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const host = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  return {
    url: `${o.tls ? "https" : "http"}://${host}:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
