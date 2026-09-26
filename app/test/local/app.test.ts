// The app of the relay (src/local/web) in a headless Chrome at phone size, against the API of the relay on a free
// port and an agent that stands in for the real one: it takes every command, opens chats, and ends the others as the
// test says. Push is faked inside the page (fakePush below): no push service is reached.
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SlotStore } from "@/agent/store/slot-store";
import { RelayDevices } from "@/local/devices";
import { apiHandler, Failures } from "@/local/server";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

const TOKEN = "p".repeat(32);
const APP = path.resolve(__dirname, "../..");
// the VAPID public key the app subscribes with: 65 bytes, as base64url
const VAPID_KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");
const CHATS = ["Test User (You)", "Anna Rossi", "Luca Bianchi"];

let browser: Browser;
let store: SlotStore;
let devices: RelayDevices;
let server: http.Server;
let base = "";
let agent: NodeJS.Timeout;
let context: BrowserContext;
let page: Page;
// how the stand-in agent ends the commands other than open
let outcome: "done" | "failed" | "unconfirmed" = "done";

// Push inside the page, as a phone that allowed notifications has it: a service worker registration whose push
// manager holds one subscription (subscribed: true) or none yet. window.fakePush counts what the app asked of it.
function fakePush({ key, subscribed }: { key: string; subscribed: boolean }) {
  const bytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const counts = { subscribe: 0, unsubscribe: 0 };
  (window as unknown as { fakePush: typeof counts }).fakePush = counts;
  type Sub = { endpoint: string; options: { applicationServerKey: ArrayBuffer }; toJSON(): object; unsubscribe(): Promise<boolean> };
  let current: Sub | null = null;
  const make = (): Sub => ({
    endpoint: "https://push.example/this-phone",
    options: { applicationServerKey: bytes(key).buffer },
    toJSON: () => ({ endpoint: "https://push.example/this-phone", expirationTime: null, keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } }),
    unsubscribe: async () => {
      counts.unsubscribe++;
      current = null;
      return true;
    },
  });
  if (subscribed) current = make();
  const registration = {
    pushManager: {
      getSubscription: async () => current,
      subscribe: async () => {
        counts.subscribe++;
        current = make();
        return current;
      },
    },
  };
  const serviceWorker = { register: async () => registration, ready: Promise.resolve(registration), getRegistration: async () => registration, addEventListener: () => undefined };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker });
  (window as unknown as { PushManager: unknown }).PushManager = function PushManager() {};
  Object.defineProperty(Notification, "permission", { configurable: true, get: () => "granted" });
  Notification.requestPermission = async () => "granted";
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const db = () => (store as unknown as { db: import("better-sqlite3").Database }).db;
const sends = () => db().prepare("SELECT arg2 FROM commands WHERE type='send' ORDER BY id").pluck().all() as string[];

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});

afterAll(async () => {
  await browser?.close();
});

beforeEach(async () => {
  outcome = "done";
  const dir = tempDir();
  store = SlotStore.open(path.join(dir, "relay.db"));
  devices = RelayDevices.open(path.join(dir, "relay.db"));
  store.saveChats(CHATS.map((name) => ({ name, preview: "", time: "10:30", unread: false, mention: false, muted: false, av: "" })));
  for (const chat of CHATS) store.saveChatMessages(chat, [{ mid: `${chat.length}01`, author: "", text: `last message of ${chat}`, mine: true, reacts: "", extra: { status: "Sent" } }]);
  const handler = apiHandler(
    { store, devices, token: TOKEN, vapidKey: VAPID_KEY, webDir: path.join(APP, "src", "local", "web"), publicDir: path.join(APP, "public"), mediaDir: path.join(dir, "media"), commandWaitMs: 1000 },
    new Failures(100),
  );
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  agent = setInterval(() => {
    store.setState(STATE.health, JSON.stringify({ cdp: "ok", teams: "ok", watcher: "ok", overall: "green", ts: nowSeconds() }));
    for (const c of store.pendingCommands()) {
      store.startCommand(c.id);
      if (c.type === "open") store.setState(STATE.activeChat, c.arg1);
      setTimeout(() => store.finishCommand(c.id, c.type === "open" ? "done" : outcome), 200);
    }
  }, 100);
  context = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await context.addInitScript((token) => localStorage.setItem("teamsrelay-token", token), TOKEN);
  page = await context.newPage();
});

afterEach(async () => {
  clearInterval(agent);
  await context?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  devices.close();
  store.close();
});

async function withPush(subscribed: boolean) {
  await context.addInitScript(fakePush, { key: VAPID_KEY, subscribed });
}

async function openChat(chat: string) {
  await page.goto(`${base}/#chat=${encodeURIComponent(chat)}`);
  await page.locator("#chat-name").filter({ hasText: chat }).waitFor();
  await page.locator("#messages li").first().waitFor();
}

async function type(text: string) {
  await page.locator("#text").fill(text);
}

const toast = () => page.locator("#toast");

describe("sending from the app", () => {
  it("sends a command whose answer got lost again with the same key, so the relay queues it once", async () => {
    const posted: { key: string; text: string }[] = [];
    let lose = true;
    await page.route("**/api/cmd", async (route) => {
      const body = route.request().postDataJSON() as { key: string; text: string; type: string };
      posted.push({ key: body.key, text: body.text });
      // the command reaches the relay, its answer is lost on the way back
      const response = await route.fetch();
      if (lose && body.type === "send") {
        lose = false;
        return route.abort("connectionreset");
      }
      return route.fulfill({ response });
    });
    await openChat("Anna Rossi");
    await type("only once");
    await page.locator("#send").click();
    await expect.poll(() => page.locator("#text").inputValue(), { timeout: 15_000 }).toBe("");
    const tries = posted.filter((p) => p.text === "only once");
    expect(tries.length).toBeGreaterThanOrEqual(2);
    expect(new Set(tries.map((p) => p.key)).size).toBe(1);
    expect(tries[0].key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(sends()).toEqual(["only once"]);
    // a new message is a new command
    await type("and a second one");
    await page.locator("#send").click();
    await expect.poll(() => page.locator("#text").inputValue(), { timeout: 15_000 }).toBe("");
    const second = posted.find((p) => p.text === "and a second one");
    expect(second?.key).toBeTruthy();
    expect(second?.key).not.toBe(tries[0].key);
    expect(sends()).toEqual(["only once", "and a second one"]);
  }, 60_000);

  it("says when Teams did not confirm a message, without inviting to send it again", async () => {
    outcome = "unconfirmed";
    await openChat("Anna Rossi");
    await type("maybe out");
    await page.locator("#send").click();
    await expect.poll(async () => (await toast().isVisible()) && (await toast().innerText()), { timeout: 15_000 }).toMatch(/did not confirm/);
    expect(await toast().innerText()).toMatch(/check the chat before sending/i);
    expect(await page.locator("#text").inputValue()).toBe("");
    expect(sends()).toEqual(["maybe out"]);
  }, 60_000);

  it("keeps the text of a message that was not sent", async () => {
    outcome = "failed";
    await openChat("Anna Rossi");
    await type("not out");
    await page.locator("#send").click();
    await expect.poll(async () => (await toast().isVisible()) && (await toast().innerText()), { timeout: 15_000 }).toMatch(/not sent|not applied/i);
    expect(await page.locator("#text").inputValue()).toBe("not out");
  }, 60_000);
});

describe("notifications of the app", () => {
  const button = () => page.locator("#push-btn");

  // the push service may renew a subscription: the relay then drops the old one (404, 410) and needs the new one
  it("sends the subscription of this phone to the relay at every start, and shows it on once the relay has it", async () => {
    await withPush(true);
    await page.goto(`${base}/`);
    await expect.poll(() => devices.count(), { timeout: 15_000 }).toBe(1);
    expect(JSON.parse(devices.targets()[0].sub).endpoint).toBe("https://push.example/this-phone");
    await expect.poll(() => button().innerText(), { timeout: 15_000 }).toBe("Notifications on");
  }, 60_000);

  it("does not show notifications on while the relay does not have the subscription", async () => {
    await withPush(true);
    let refused = 0;
    await page.route("**/api/push", (route) => (refused++, route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"down"}' })));
    await page.goto(`${base}/`);
    await expect.poll(() => refused, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1000);
    expect(await button().innerText()).toBe("Notifications");
    expect(devices.count()).toBe(0);
  }, 60_000);

  it("turns notifications on from the button", async () => {
    await withPush(false);
    await page.goto(`${base}/`);
    await page.locator("#chats li").first().waitFor();
    expect(await button().innerText()).toBe("Notifications");
    await button().click();
    await expect.poll(() => button().innerText(), { timeout: 15_000 }).toBe("Notifications on");
    expect(devices.count()).toBe(1);
  }, 60_000);
});
