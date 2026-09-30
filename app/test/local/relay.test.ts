// The relay in one process, as src/local/main.ts wires it: the real launcher on a headless Chrome (own profile,
// sandbox on), the agent loop, the API and the Web Push call. Teams is a page that behaves like it
// (fake-teams.html), served by a route of the browser context: nothing reaches the real Teams. What the relay reads
// from real Teams is covered by the page script tests on captured fixtures.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NewMessageDetector } from "@/agent/logic/new-messages";
import { selfCheckWindow } from "@/agent/logic/self-check";
import { runAgent } from "@/agent/loop";
import { Media } from "@/agent/media";
import { Notifier } from "@/agent/push/notifier";
import { loadVapidKeys } from "@/agent/push/vapid";
import { SlotStore } from "@/agent/store/slot-store";
import { STATE } from "@/shared/slot-db/state";
import { BrowserKeeper, launchBrowser } from "@/local/browser";
import { loadConfig, type Config } from "@/local/config";
import { RelayDevices } from "@/local/devices";
import { startServer, type RunningServer } from "@/local/server";
import { tempDir } from "../helpers";
import { fakePushService } from "./fake-push";

const TOKEN = "r".repeat(32);
const FAKE_TEAMS = fs.readFileSync(path.join(__dirname, "fake-teams.html"), "utf8");
const APP = path.resolve(__dirname, "../..");

let config: Config;
let store: SlotStore;
let devices: RelayDevices;
let push: Awaited<ReturnType<typeof fakePushService>>;
let server: RunningServer;
let keeper: BrowserKeeper;
let stop: AbortController;
let loop: Promise<void>;
const contexts: BrowserContext[] = [];

const teams = (): Page => {
  const page = contexts[contexts.length - 1]?.pages().find((p) => p.url().startsWith("https://teams.cloud.microsoft"));
  if (!page) throw new Error("no Teams tab");
  return page;
};

async function until<T>(what: string, check: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeout = 30_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function api(p: string, body?: unknown) {
  const r = await fetch(server.url + p, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers of the API, checked field by field below
  return { status: r.status, json: (await r.json()) as Record<string, any> };
}

const payloads = () => push.received.map((r) => r.payload as { title: string; body: string; chat: string });

beforeAll(async () => {
  const dir = tempDir("teamsrelay-relay-");
  const loaded = loadConfig({ STATE_DIR: dir, HOST_LABEL: "test-pc" });
  config = { ...loaded, alerts: { ...loaded.alerts, signInAfter: 2, signInTryAfter: 1, signInTryWait: 10 } };
  execFileSync(process.execPath, [path.join(APP, "scripts", "gen-vapid.mjs"), path.dirname(config.vapid.privateKeyFile)], { stdio: "pipe" });
  const vapid = loadVapidKeys(config.vapid.privateKeyFile, config.vapid.appKeyFile);
  store = SlotStore.open(config.dbPath);
  // the automatic check (8-11 and 17-20 local time) would add its push to the exact list checked at the end: the
  // windows the test can run in are marked as checked already
  for (const at of [Date.now(), Date.now() + 10 * 60_000]) {
    const key = selfCheckWindow(new Date(at));
    if (key) store.setState(key, "1");
  }
  devices = RelayDevices.open(config.dbPath);
  push = await fakePushService();
  const sub = push.subscription("phone");
  devices.save(sub.endpoint, JSON.stringify(sub), "test phone");
  const notifier = new Notifier({ store, devices, vapid, subject: "mailto:relay@example.com", ntfy: null, send: push.send });
  keeper = new BrowserKeeper(async () => {
    const context = await launchBrowser({ profileDir: config.profileDir, channel: "chrome", headless: true });
    await context.route("https://teams.cloud.microsoft/**", (r) => r.fulfill({ contentType: "text/html", body: FAKE_TEAMS }));
    contexts.push(context);
    return context;
  }, config.teamsUrl);
  server = await startServer({
    bind: "127.0.0.1",
    port: 0,
    tls: null,
    store,
    devices,
    token: TOKEN,
    vapidKey: vapid?.publicKey ?? "",
    webDir: path.join(APP, "src", "local", "web"),
    publicDir: path.join(APP, "public"),
    mediaDir: config.mediaDir,
  });
  stop = new AbortController();
  loop = runAgent({ config, store, notifier, media: new Media(config.mediaDir, path.join(dir, "files")), detector: new NewMessageDetector() }, keeper, stop.signal);
});

afterAll(async () => {
  stop?.abort();
  await keeper?.close();
  await loop;
  await server?.close();
  await push?.close();
});

describe("relay against a Teams page", () => {
  it("reads chats and account, and says it is green", async () => {
    const state = await until("green state with chats", async () => {
      const s = (await api("/api/state")).json;
      return s.health?.overall === "green" && s.me?.email && s.chats?.length === 3 ? s : null;
    });
    expect(state.chats.map((c: { name: string }) => c.name)).toEqual(["Test User (You)", "Anna Rossi", "Luca Bianchi"]);
    expect(state.me).toEqual({ name: "Test User", email: "test.user@contoso.example", tenant: "Contoso" });
    expect(state.health).toMatchObject({ cdp: "ok", teams: "ok", presence: "available", push_subs: 1, agent: "ok" });
  }, 60_000);

  it("pushes a new incoming message to the phone, encrypted, with its chat", async () => {
    await teams().evaluate(() => (window as unknown as { fakeTeams: { incoming(n: string, t: string): void } }).fakeTeams.incoming("Luca Bianchi", "can you check the deploy?"));
    const p = await until("the push of the message", () => payloads().find((x) => x.body === "can you check the deploy?"));
    expect(p).toEqual({ title: "Luca Bianchi", body: "can you check the deploy?", chat: "Luca Bianchi", tag: "chat-0-Luca Bianchi", ts: expect.any(Number) });
    expect(push.received.at(-1)?.vapid).toMatchObject({ aud: "https://push.test", sub: "mailto:relay@example.com" });
  }, 60_000);

  it("sends a message from the phone and answers once Teams shows it sent", async () => {
    const r = await api("/api/cmd", { type: "send", chat: "Anna Rossi", text: "on my way" });
    expect(r).toEqual({ status: 200, json: { id: expect.any(Number), status: "done" } });
    const shown = await api(`/api/messages?chat=${encodeURIComponent("Anna Rossi")}`);
    expect(shown.json.open).toBe(true);
    expect(shown.json.messages.at(-1)).toMatchObject({ text: "on my way", mine: true, status: "Sent" });
    expect(shown.json.messages.at(-1).mid).toMatch(/^\d{13}$/);
  }, 60_000);

  // the one press of Sign in after a sign-out (src/agent/jobs/sign-in.ts): a real click the page takes as a person's
  it("presses Teams' own Sign in once when Teams asks, and pushes nothing when that brings Teams back", async () => {
    const before = payloads().length;
    await teams().evaluate(() => (window as unknown as { fakeTeams: { signOut(button: boolean): void } }).fakeTeams.signOut(true));
    await until("the press", () => store.getState(STATE.signInTry).includes('"teams"'));
    await until("Teams back", async () => (await api("/api/state")).json.health?.teams === "ok");
    // past the alert of a sign-out without a press (2 s here) and the wait of a press (10 s here)
    await new Promise((r) => setTimeout(r, 12_000));
    expect(payloads()).toHaveLength(before);
  }, 60_000);

  it("pushes once when Teams is signed out for a while, refuses commands meanwhile, and pushes again when it is back", async () => {
    await teams().evaluate(() => (window as unknown as { fakeTeams: { signOut(): void } }).fakeTeams.signOut());
    await until("the signed-out push", () => payloads().find((x) => x.title === "Teams signed out"));
    expect(payloads().filter((x) => x.title === "Teams signed out")).toEqual([
      { title: "Teams signed out", body: "Sign in again in the relay window on test-pc: no messages until then.", chat: "" },
    ]);
    const refused = await api("/api/cmd", { type: "send", chat: "Anna Rossi", text: "lost" });
    expect(refused.status).toBe(409);
    await teams().evaluate(() => (window as unknown as { fakeTeams: { signIn(): void } }).fakeTeams.signIn());
    await until("the back push", () => payloads().find((x) => x.title === "Teams back"));
  }, 60_000);

  it("starts the browser again when it closes, and goes back to reading Teams", async () => {
    const before = contexts.length;
    await contexts[before - 1].close();
    await until("a new browser", () => contexts.length > before);
    const since = Math.floor(Date.now() / 1000);
    await until("a fresh green state", async () => {
      const h = (await api("/api/state")).json.health;
      return h?.overall === "green" && h.ts >= since;
    });
    const r = await api("/api/cmd", { type: "send", chat: "Anna Rossi", text: "still here" });
    expect(r.json.status).toBe("done");
  }, 60_000);

  it("pushed exactly the new message and the two sign-in alerts: nothing for its own sends, nothing for a restart", () => {
    expect(payloads().map((p) => `${p.title}: ${p.body}`)).toEqual([
      "Luca Bianchi: can you check the deploy?",
      "Teams signed out: Sign in again in the relay window on test-pc: no messages until then.",
      "Teams back: Signed in again: messages are relayed.",
    ]);
  });

  // the owner in the window of the relay: the agent's own sends, reads and presence keeper never count as the owner's
  // input, a click it did not send does, and the agent then leaves Teams as it is
  it("leaves Teams to the owner after a click the agent did not send, and says so in its health", async () => {
    const since = Math.floor(Date.now() / 1000);
    const h = await until("a fresh health", async () => {
      const health = (await api("/api/state")).json.health;
      return health?.ts > since ? health : null;
    });
    expect(h.desktop).toBeUndefined();
    await teams().mouse.click(5, 300);
    await until("the health in use", async () => (await api("/api/state")).json.health?.desktop === "in-use");
  }, 60_000);
});
