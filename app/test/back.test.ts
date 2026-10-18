// Back on a phone in the local Google Chrome, headless: the levels of test/back-page.tsx opened and closed by clicks,
// the history of the tab read through CDP. The Android app goes back in its WebView only while the page has an entry to
// go back to, else it closes (Tauri AppPlugin.kt): each level open has to leave one, and a level closed none.
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let browser: Browser;
let page: Page;
let cdp: CDPSession;
// the history of the tab with the page just loaded, after a page of another site, as the start page of the Android
// app before the server
let base = 0;
let loaded = 0;

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(__dirname, "back-page.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: path.join(__dirname, "../tsconfig.json"),
    logLevel: "silent",
  });
  const html = `<!doctype html><html><body><div id="root"></div><script>${out.outputFiles[0].text}</script></body></html>`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 393, height: 800 }, isMobile: true, hasTouch: true });
  await page.route("http://back.test/**", (route) => route.fulfill({ contentType: "text/html", body: html }));
  cdp = await page.context().newCDPSession(page);
});

afterAll(async () => {
  await browser?.close();
});

const history = async () => {
  const h = await cdp.send("Page.getNavigationHistory");
  return { index: h.currentIndex, entries: h.entries.length };
};
const at = async () => (await history()).index - base;
const shown = () => page.textContent("#shown");
const sameDocument = () => page.evaluate(() => (window as Window & { loaded?: number }).loaded);

beforeEach(async () => {
  await page.goto("about:blank");
  await page.goto("http://back.test/");
  await page.waitForSelector("#shown");
  base = (await history()).index;
  loaded = (await sameDocument()) ?? 0;
});

describe("Back on a phone", () => {
  it("closes the chat and stays on the page", async () => {
    await page.click("text=Open chat");
    await expect.poll(at).toBe(1);
    await page.goBack({ waitUntil: "commit" });
    await expect.poll(shown).toBe("list");
    expect(await at()).toBe(0);
    expect(await sameDocument()).toBe(loaded);
  });

  it("finds no entry left by chats closed with their arrow: from the list it leaves the page", async () => {
    for (let i = 0; i < 3; i++) {
      await page.click("text=Open chat");
      await expect.poll(at).toBe(1);
      await page.click("text=Arrow");
      await expect.poll(shown).toBe("list");
      await expect.poll(at).toBe(0);
    }
    expect((await history()).entries).toBe(base + 2);
    await page.goBack({ waitUntil: "commit" });
    await expect.poll(() => page.url()).toBe("about:blank");
  });

  it("goes from the remote desktop back to the chat it was opened from, then to the list", async () => {
    await page.click("text=Open chat");
    await page.click("text=Desktop");
    await expect.poll(at).toBe(2);
    await page.goBack({ waitUntil: "commit" });
    await expect.poll(shown).toBe("chat");
    await page.goBack({ waitUntil: "commit" });
    await expect.poll(shown).toBe("list");
    expect(await at()).toBe(0);
    expect(await sameDocument()).toBe(loaded);
  });

  it("closes the remote desktop opened from the list", async () => {
    await page.click("text=Desktop");
    await expect.poll(at).toBe(1);
    await page.goBack({ waitUntil: "commit" });
    await expect.poll(shown).toBe("list");
  });

  it("finds no entry left after a tab closed the remote desktop and the chat under it at once", async () => {
    await page.click("text=Open chat");
    await page.click("text=Desktop");
    await expect.poll(at).toBe(2);
    await page.click("text=Chats tab");
    await expect.poll(shown).toBe("list");
    await expect.poll(at).toBe(0);
    expect(await sameDocument()).toBe(loaded);
  });

  it("keeps a chat opened while the history still goes back from the one closed before", async () => {
    await page.click("text=Open chat");
    await expect.poll(at).toBe(1);
    // React renders the arrow's click in a microtask and goes back, whose popstate comes in a later task: the second chat
    // opens in between
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === text)!;
          addEventListener("popstate", () => setTimeout(resolve, 100), { once: true });
          button("Arrow").click();
          void Promise.resolve().then(() => button("Open chat").click());
        }),
    );
    expect(await shown()).toBe("chat");
    expect(await at()).toBe(1);
  });

  it("goes back again from a level closed since that Forward brought back", async () => {
    await page.click("text=Open chat");
    await expect.poll(at).toBe(1);
    await page.goBack({ waitUntil: "commit" });
    await expect.poll(shown).toBe("list");
    await page.goForward({ waitUntil: "commit" });
    await expect.poll(at).toBe(0);
    expect(await shown()).toBe("list");
  });
});
