import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// The start page in Chrome (installed Google Chrome, headless), served as the app serves it, with a made-up
// server at https://relay.test answered by the test.
const START = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "start");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const RELAY = "https://relay.test";

let server;
let origin;
let browser;
// Playwright turns the back/forward cache off; this one keeps it, as the Android WebView does
let cachingBrowser;

before(async () => {
  server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://x").pathname.replace(/^\/$/, "/index.html");
    const file = path.join(START, name);
    if (!file.startsWith(START) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  cachingBrowser = await chromium.launch({ channel: "chrome", headless: true, ignoreDefaultArgs: ["--disable-back-forward-cache"] });
});

after(async () => {
  await browser?.close();
  await cachingBrowser?.close();
  server?.close();
});

async function newPage(from = browser) {
  const context = await from.newContext();
  await context.route(`${RELAY}/**`, (route) => route.fulfill({ contentType: "text/html", body: "<title>relay</title><p>TeamsRelay server page</p>" }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { page, errors };
}

test("asks for the address on the first start, refuses a wrong one, then opens the server", async () => {
  const { page, errors } = await newPage();
  await page.goto(origin + "/");
  assert.equal(await page.isVisible("#relay-form"), true);
  assert.equal(await page.isVisible("#opening"), false);

  await page.fill("#relay", "http://teamsrelay.example.com");
  await page.click("button[type=submit]");
  assert.match(await page.textContent("#error"), /https:\/\//);
  assert.equal(page.url(), origin + "/");

  await page.fill("#relay", "https://relay.test/some/path?a=1");
  await Promise.all([page.waitForURL(`${RELAY}/`), page.click("button[type=submit]")]);
  assert.equal(await page.title(), "relay");

  // Back from the server page: the form again, with the address in use
  await page.goBack();
  await page.waitForURL(origin + "/");
  await page.waitForSelector("#relay-form", { state: "visible" });
  assert.equal(await page.inputValue("#relay"), RELAY);
  assert.deepEqual(errors, []);
});

test("goes straight to the saved server", async () => {
  const { page, errors } = await newPage();
  await page.goto(origin + "/");
  await page.fill("#relay", "https://relay.test");
  await Promise.all([page.waitForURL(`${RELAY}/`), page.click("button[type=submit]")]);

  await page.goto(origin + "/");
  await page.waitForURL(`${RELAY}/`);
  assert.equal(await page.title(), "relay");
  assert.deepEqual(errors, []);
});

test("shows the address with #change instead of opening the server", async () => {
  const { page, errors } = await newPage();
  await page.goto(origin + "/");
  await page.fill("#relay", "https://relay.test");
  await Promise.all([page.waitForURL(`${RELAY}/`), page.click("button[type=submit]")]);

  await page.goto(origin + "/#change");
  await page.waitForSelector("#relay-form", { state: "visible" });
  assert.equal(await page.inputValue("#relay"), RELAY);
  assert.equal(page.url(), origin + "/#change");
  assert.deepEqual(errors, []);
});

test("shows the address again when Back restores the page from the back/forward cache", async () => {
  const { page, errors } = await newPage(cachingBrowser);
  // set on the start page when Chrome brings it back from the cache instead of loading it again
  await page.addInitScript(() => addEventListener("pageshow", (e) => e.persisted && (window.restored = true)));
  await page.goto(origin + "/");
  await page.fill("#relay", "https://relay.test/some/path");
  await Promise.all([page.waitForURL(`${RELAY}/`), page.click("button[type=submit]")]);

  // a page restored from the cache fires no load event
  await page.goBack({ waitUntil: "commit" });
  await page.waitForURL(origin + "/", { waitUntil: "commit" });
  await page.waitForSelector("#relay-form", { state: "visible" });
  assert.equal(await page.evaluate(() => window.restored), true);
  assert.equal(await page.inputValue("#relay"), RELAY);
  assert.deepEqual(errors, []);
});

// In the app, the push plugin (plugin/android) answers the start page: it takes the server and the address of the
// page, and says what started the app (launch: the account of a tapped notification, the launcher shortcut Change
// server)
async function inTheApp(page, launch) {
  const invoked = [];
  await page.exposeBinding("recordInvoke", (_source, cmd, args) => invoked.push([cmd, args]));
  await page.addInitScript((launch) => {
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        await window.recordInvoke(cmd, args ?? null);
        return cmd === "plugin:push|opened" ? launch : null;
      },
    };
  }, launch);
  return invoked;
}

// The server address the start page opens in the app: the account asked, the sound of a call answered from its
// notification (call=1), and the page itself for Change server
const inApp = (server, acc = 0, call = false) => `${server}/?${acc ? `a=${acc}&` : ""}${call ? "call=1&" : ""}app=${encodeURIComponent(origin + "/")}`;

test("in the app, hands the server and the address of the page to the plugin", async () => {
  const { page, errors } = await newPage();
  const invoked = await inTheApp(page, { acc: 0, change: false });
  await page.goto(origin + "/");
  await page.fill("#relay", "https://relay.test");
  await Promise.all([page.waitForURL(inApp(RELAY)), page.click("button[type=submit]")]);
  assert.deepEqual(invoked.slice(0, 2), [
    ["plugin:push|opened", null],
    ["plugin:push|relay", { origin: RELAY, page: origin + "/" }],
  ]);
  assert.deepEqual(errors, []);
});

test("in the app, opens the saved server on the account of the notification that started the app", async () => {
  const { page, errors } = await newPage();
  await inTheApp(page, { acc: 2, change: false });
  await page.goto(origin + "/");
  await page.fill("#relay", "https://relay.test");
  await Promise.all([page.waitForURL(inApp(RELAY)), page.click("button[type=submit]")]);
  await page.goto(origin + "/");
  await page.waitForURL(inApp(RELAY, 2));
  assert.deepEqual(errors, []);
});

test("in the app, Answer on a call notification opens the account with the sound of the call once the server took it", async () => {
  const { page, errors } = await newPage();
  await inTheApp(page, { acc: 2, change: false, call: true });
  await page.goto(origin + "/");
  await page.fill("#relay", "https://relay.test");
  await Promise.all([page.waitForURL(inApp(RELAY)), page.click("button[type=submit]")]);
  await page.goto(origin + "/");
  await page.waitForURL(inApp(RELAY, 2, true));
  assert.deepEqual(errors, []);
});

test("in the app, Answer the server refused (the call no longer rings) opens the account without the call", async () => {
  const { page, errors } = await newPage();
  await inTheApp(page, { acc: 2, change: false, call: false });
  await page.goto(origin + "/");
  await page.fill("#relay", "https://relay.test");
  await Promise.all([page.waitForURL(inApp(RELAY)), page.click("button[type=submit]")]);
  await page.goto(origin + "/");
  await page.waitForURL(inApp(RELAY, 2));
  assert.deepEqual(errors, []);
});

test("in the app, opens the saved server as it is when no notification started it", async () => {
  const { page, errors } = await newPage();
  await inTheApp(page, { acc: 0, change: false });
  await page.goto(origin + "/");
  await page.fill("#relay", "https://relay.test");
  await Promise.all([page.waitForURL(inApp(RELAY)), page.click("button[type=submit]")]);
  await page.goto(origin + "/");
  await page.waitForURL(inApp(RELAY));
  assert.deepEqual(errors, []);
});

test("in the app, the launcher shortcut Change server shows the form with the address in use", async () => {
  const { page, errors } = await newPage();
  await inTheApp(page, { acc: 0, change: true });
  await page.context().route("https://other.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>other</title>" }));
  await page.goto(origin + "/");
  await page.fill("#relay", "https://relay.test");
  await Promise.all([page.waitForURL(inApp(RELAY)), page.click("button[type=submit]")]);

  // started from the shortcut: the form, the saved address filled in, nothing opened
  await page.goto(origin + "/");
  await page.waitForSelector("#relay-form", { state: "visible" });
  assert.equal(await page.inputValue("#relay"), RELAY);
  assert.equal(page.url(), origin + "/");

  // another server, opened with the page named for the next Change server
  await page.fill("#relay", "https://other.test");
  await Promise.all([page.waitForURL(inApp("https://other.test")), page.click("button[type=submit]")]);
  assert.deepEqual(errors, []);
});
