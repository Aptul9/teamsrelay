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
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function newPage() {
  const context = await browser.newContext();
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
  const { page } = await newPage();
  await page.goto(origin + "/");
  await page.fill("#relay", "https://relay.test");
  await Promise.all([page.waitForURL(`${RELAY}/`), page.click("button[type=submit]")]);

  await page.goto(origin + "/#change");
  await page.waitForSelector("#relay-form", { state: "visible" });
  assert.equal(await page.inputValue("#relay"), RELAY);
  assert.equal(page.url(), origin + "/#change");
});
