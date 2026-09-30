// The open chat of the web app in the local Google Chrome, headless: while Teams opens the chat for this visit the app
// says so, over the messages saved at the last one; it says why when Teams could not open it, and asks again on Try
// again. The page asks /api/open of the routes here; the messages and the last open come as the event stream sends them.
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page, type Route } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Message, OpenStatus } from "@/lib/client";

let browser: Browser;
let page: Page;
let js = "";
let errors: string[];
// what /api/open answers, and the chats it was asked to open
let answer: { status: number; body: unknown };
let asked: string[];

const BASE = "http://chat.test/";

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(__dirname, "conversation-page.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: path.join(__dirname, "../tsconfig.json"),
    logLevel: "silent",
  });
  js = out.outputFiles[0].text;
  browser = await chromium.launch({ channel: "chrome", headless: true });
});

afterAll(async () => {
  await browser?.close();
});

beforeEach(async () => {
  errors = [];
  asked = [];
  answer = { status: 200, body: { ok: true, id: 41 } };
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(`${BASE}**`, (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/open") {
      asked.push(JSON.parse(route.request().postData() || "{}").name);
      return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
    }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="root"></div><script>${js}</script></body></html>` });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(BASE);
  await expect.poll(() => page.evaluate(() => typeof (window as { setView?: unknown }).setView)).toBe("function");
});

const saved: Message[] = [{ mid: "1790670000000", author: "Anna Rossi", text: "saved at the last visit", mine: 0, reacts: "" }];
const setView = (rows: Message[] | null, open: OpenStatus | null, stopped = false, callable = false) =>
  page.evaluate((v) => (window as unknown as { setView: (x: unknown) => void }).setView(v), { rows, open, stopped, callable });
const shows = (text: string) => page.evaluate((t) => document.body.innerText.includes(t), text);
const until = (text: string, shown = true) => expect.poll(() => shows(text), { timeout: 5000 }).toBe(shown);

describe("a chat opening in Teams", () => {
  it("shows the saved messages under Opening in Teams until the open of this visit is done", async () => {
    await expect.poll(() => asked).toEqual(["Anna Rossi"]);
    // the stream still has the open of the last visit, done
    await setView(saved, { id: 40, status: "done" });
    await until("saved at the last visit");
    await until("Opening in Teams");
    await setView(saved, { id: 41, status: "pending" });
    await until("Opening in Teams");
    await setView(saved, { id: 41, status: "done" });
    await until("Opening in Teams", false);
    await until("saved at the last visit");
    expect(errors).toEqual([]);
  });

  it("says No messages only once Teams opened a chat that has none", async () => {
    await setView([], { id: 41, status: "pending" });
    await until("Opening the chat in Teams");
    // longer than the 5 s the app used to wait before saying No messages
    await new Promise((r) => setTimeout(r, 6000));
    expect(await shows("No messages in this chat")).toBe(false);
    await setView([], { id: 41, status: "done" });
    await until("No messages in this chat");
    await until("Opening the chat in Teams", false);
  });

  it("says why when Teams did not open the chat, and Try again asks again", async () => {
    await expect.poll(() => asked.length).toBe(1);
    await setView(saved, { id: 41, status: "failed", reason: "not-listed" });
    await until("Teams did not open this chat");
    await until("Teams has no chat with this name in its list");
    await until("saved at the last visit");
    answer = { status: 200, body: { ok: true, id: 42 } };
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => asked).toEqual(["Anna Rossi", "Anna Rossi"]);
    await until("Opening in Teams");
    await until("Teams has no chat with this name in its list", false);
    await setView(saved, { id: 42, status: "done" });
    await until("Opening in Teams", false);
  });

  it("gives the reason of each failed open, and a generic one for an open that got no answer", async () => {
    await expect.poll(() => asked.length).toBe(1);
    const reasons: [OpenStatus["reason"], string][] = [
      ["signed-out", "Teams is signed out"],
      ["not-shown", "Teams did not show it"],
      ["unreadable", "its messages could not be read"],
      [undefined, "Teams did not get to it in time"],
    ];
    for (const [reason, text] of reasons) {
      await setView(saved, { id: 41, status: "failed", ...(reason ? { reason } : {}) });
      await until(text);
    }
  });

  it("says why when the open could not even be asked", async () => {
    await page.close();
    page = await browser.newPage();
    answer = { status: 409, body: { detail: "Not connected: its relay is off" } };
    await page.route(`${BASE}**`, (route: Route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/open") return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="root"></div><script>${js}</script></body></html>` });
    });
    await page.goto(BASE);
    await expect.poll(() => page.evaluate(() => typeof (window as { setView?: unknown }).setView)).toBe("function");
    await setView(saved, null);
    await until("Not connected: its relay is off");
    await until("Try again");
  });

  it("asks nothing for a stopped account and shows its saved messages as they are", async () => {
    await page.close();
    page = await browser.newPage();
    asked = [];
    await page.route(`${BASE}**`, (route: Route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/open") {
        asked.push("?");
        return route.fulfill({ contentType: "application/json", body: '{"ok":true,"id":50}' });
      }
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="root"></div><script>${js}</script></body></html>` });
    });
    await page.goto(`${BASE}?stopped`);
    await expect.poll(() => page.evaluate(() => typeof (window as { setView?: unknown }).setView)).toBe("function");
    await setView(saved, { id: 40, status: "done" }, true);
    await until("saved at the last visit");
    await new Promise((r) => setTimeout(r, 500));
    expect(await shows("Opening in Teams")).toBe(false);
    expect(asked).toEqual([]);
    // nor when the app comes back on screen
    await page.clock.install();
    await visibility("hidden");
    await page.clock.fastForward("05:00");
    await visibility("visible");
    await new Promise((r) => setTimeout(r, 500));
    expect(asked).toEqual([]);
  });
});

// A 1:1 chat of an account of the browsers container: the header offers to call the person, and asks first
describe("calling the person of the chat", () => {
  const called = () => page.evaluate(() => (window as unknown as { called?: number }).called ?? 0);
  const callButton = () => page.locator('header button[aria-label="Call Anna Rossi"]');

  it("offers Call only where the app can call", async () => {
    await setView(saved, { id: 41, status: "done" });
    await until("saved at the last visit");
    expect(await callButton().count()).toBe(0);
    await setView(saved, { id: 41, status: "done" }, false, true);
    await expect.poll(() => callButton().count()).toBe(1);
  });

  it("asks before calling: Call calls once, Cancel calls nobody", async () => {
    await setView(saved, { id: 41, status: "done" }, false, true);
    await callButton().click();
    await until("Call Anna Rossi?");
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await until("Call Anna Rossi?", false);
    expect(await called()).toBe(0);
    await callButton().click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Call", exact: true }).click();
    await until("Call Anna Rossi?", false);
    expect(await called()).toBe(1);
    expect(errors).toEqual([]);
  });
});

// hides or shows the page, as a switch to another tab or window does
const visibility = (state: "hidden" | "visible") =>
  page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);

// Away from the app for long, Teams went back to the self chat: the chat on screen is opened again, and says so
describe("a chat back on screen", () => {
  it("asks Teams to open the chat again after a minute or more away, not after a short absence", async () => {
    await page.clock.install();
    await expect.poll(() => asked).toEqual(["Anna Rossi"]);
    await setView(saved, { id: 41, status: "done" });
    await until("Opening in Teams", false);
    // half a minute in another tab: Teams still shows the chat, the messages on return are current
    await visibility("hidden");
    await page.clock.fastForward("00:30");
    await visibility("visible");
    await new Promise((r) => setTimeout(r, 500));
    expect(asked).toEqual(["Anna Rossi"]);
    expect(await shows("Opening in Teams")).toBe(false);
    // over a minute: opened again, the saved messages dimmed under Opening in Teams until that open is done
    answer = { status: 200, body: { ok: true, id: 42 } };
    await visibility("hidden");
    await page.clock.fastForward("01:05");
    await visibility("visible");
    await expect.poll(() => asked).toEqual(["Anna Rossi", "Anna Rossi"]);
    await until("Opening in Teams");
    await until("saved at the last visit");
    await setView(saved, { id: 42, status: "done" });
    await until("Opening in Teams", false);
    expect(errors).toEqual([]);
  });
});
