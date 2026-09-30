// The link of a joined relay against a server that offers HTTP/2, as Caddy does. Node 26's fetch took HTTP/2 and sent
// every request of the relay down that one connection, where the sync and the notifications waited for the long poll
// of the commands (up to 25 s). Served here over TLS, HTTP/2 and HTTP/1.1 offered, with a certificate made for the test.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { SlotStore } from "@/agent/store/slot-store";
import { ServerLink } from "@/local/server-link";
import { tempDir } from "../helpers";

// the long poll of the commands, held by the server this long
const HOLD_MS = 4_000;

let root: string;
let server: http2.Http2SecureServer;
let url: string;
let store: SlotStore;
let link: ServerLink;
const stop = new AbortController();
let running: Promise<void>;
// a long poll the server holds now
let holding = 0;
const protocols = new Set<string>();
const rejectBefore = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

beforeAll(async () => {
  root = tempDir("teamsrelay-h2-");
  const key = path.join(root, "key.pem");
  const cert = path.join(root, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert,
  ], { stdio: "ignore" });
  server = http2.createSecureServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), allowHTTP1: true }, (req, res) => {
    protocols.add(req.httpVersion);
    const u = new URL(req.url ?? "/", "https://127.0.0.1");
    const answer = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json", date: new Date().toUTCString() });
      res.end(JSON.stringify(body));
    };
    req.resume();
    req.on("end", () => {
      if (u.pathname === "/api/relay/commands") {
        const reply = () => answer({ added: 1, commands: [], viewing: null, devices: 1 });
        if (u.searchParams.get("wait") === "0") return reply();
        holding++;
        setTimeout(() => {
          holding--;
          reply();
        }, HOLD_MS);
        return;
      }
      if (u.pathname === "/api/relay/push") return answer({ sent: 1 });
      answer({});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // the certificate of the test is its own: trusted for this file only
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  store = SlotStore.open(path.join(root, "relay.db"));
  link = new ServerLink({
    url,
    token: "t",
    host: "test-pc",
    dbPath: path.join(root, "relay.db"),
    store,
    mediaDir: path.join(root, "media"),
    filesDir: path.join(root, "files"),
    uploadsDir: path.join(root, "uploads"),
  });
  running = link.run(stop.signal);
});

afterAll(async () => {
  stop.abort();
  await running;
  store?.close();
  server?.close();
  if (rejectBefore === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = rejectBefore;
});

it("sends a notification at once while the long poll of the commands waits", async () => {
  const end = Date.now() + 10_000;
  while (!holding && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  expect(holding).toBe(1);
  const t0 = Date.now();
  const sent = await link.push({ op: "alert", title: "t", body: "b", urgency: "high" });
  const took = Date.now() - t0;
  expect(sent).toBe(1);
  expect(holding).toBe(1);
  expect(took).toBeLessThan(1_000);
}, 20_000);
