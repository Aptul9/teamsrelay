// The two lines of relay.env the app shows for an account on another computer, in the local Google Chrome, headless:
// the address of the server as the server gives it (the page may be open under another name), and a copy that fails
// leaves the lines selected, saying so.
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let browser: Browser;
let page: Page;
const errors: string[] = [];

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(__dirname, "relay-token-page.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: path.join(__dirname, "../tsconfig.json"),
    logLevel: "silent",
  });
  const js = out.outputFiles[0].text;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://token.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="root"></div><script>${js}</script></body></html>` }),
  );
  await page.goto("http://token.test/");
  await page.waitForFunction(() => typeof (window as Window & { show?: unknown }).show === "function");
});

afterAll(async () => {
  await browser?.close();
});

const LINES = "SERVER_URL=https://teams.example.test\nSERVER_TOKEN=tok-123";

describe("the token of an account on another computer", () => {
  it("comes with the address of the server the server gave, not the one of the page", async () => {
    await page.evaluate(() => (window as Window & { show?: (t: string, s: string) => void }).show?.("tok-123", "https://teams.example.test"));
    await expect.poll(() => page.locator("pre").innerText()).toBe(LINES);
  });

  it("is left selected, with a word on it, when the copy fails", async () => {
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } }));
    await page.getByRole("button", { name: "Copy" }).click();
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(LINES);
    await expect.poll(() => page.getByRole("alertdialog").innerText()).toMatch(/Could not copy: the lines are selected/);
    expect(errors).toEqual([]);
  });
});
