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
