import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@/lib/client";

const BASE = "https://copy.test/";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0hoAAAAASUVORK5CYII=", "base64");
let browser: Browser;
let context: BrowserContext;
let page: Page;
let js: string;
let errors: string[];
const rows: Message[] = [
  { mid: "1794038700000", author: "Anna Rossi", text: "Question", mine: 0, reacts: "" },
  { mid: "1794038760000", author: "Luca Bianchi", text: "Answer", quote: { author: "Anna Rossi", text: "Question" }, mine: 0, reacts: "" },
  { mid: "1794038820000", author: "Antonio", text: "", images: [{ f: "sample.png" }], mine: 1, reacts: "" },
];

beforeAll(async () => {
  const out = await build({ entryPoints: [path.join(__dirname, "conversation-page.tsx")], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, tsconfig: path.join(__dirname, "../tsconfig.json"), logLevel: "silent" });
  js = out.outputFiles[0].text;
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => { await browser?.close(); });
afterEach(async () => { await context?.close(); });
beforeEach(async () => {
  errors = [];
  context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(`${BASE}**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/open") return route.fulfill({ json: { ok: true, id: 41 } });
    if (url.pathname === "/media/sample.png") return route.fulfill({ contentType: "image/png", body: PNG });
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="root"></div><div id="outside">Outside text</div><script>${js}</script></body></html>` });
    return route.fulfill({ status: 404 });
  });
  await page.goto(BASE);
  await page.waitForFunction(() => typeof (window as unknown as { setView: unknown }).setView === "function");
  await page.evaluate((rows) => (window as unknown as { setView: (v: unknown) => void }).setView({ rows, open: { id: 41, status: "done" } }), rows);
  await page.locator(`[data-copy-message="${rows[1].mid}"]`).waitFor();
  await page.evaluate(() => navigator.clipboard.writeText("Before copy"));
});

const clipboard = () => page.evaluate(async () => {
  const items = await navigator.clipboard.read();
  const result: Record<string, string> = {};
  for (const item of items) for (const type of item.types) result[type] = (await (await item.getType(type)).text()).replace(/\r\n/g, "\n");
  return result;
});
const select = (first: string, last = first) => page.evaluate(({ first, last }) => {
  const start = document.querySelector(first)!;
  const end = document.querySelector(last)!;
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.childNodes.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}, { first, last });
const bubble = (i: number) => `[data-copy-message="${rows[i].mid}"]`;

describe("copy from the conversation", () => {
  it("copies one message from its desktop menu with both clipboard flavors", async () => {
    await page.locator(`[data-mid="${rows[1].mid}"]`).getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Copy message" }).click();
    await expect.poll(async () => (await clipboard())["text/plain"]).toContain("> in reply to Anna Rossi: Question\nAnswer");
    expect((await clipboard())["text/html"]).toContain("Teams chat: Anna Rossi");
    expect(errors).toEqual([]);
  });

  it("enriches a multi-message Ctrl+C selection in message order", async () => {
    await page.locator(bubble(0)).click();
    await select(bubble(0), bubble(1));
    await page.keyboard.press("Control+c");
    await expect.poll(async () => (await clipboard())["text/plain"]).toContain("Luca Bianchi");
    const text = (await clipboard())["text/plain"];
    expect(text.indexOf("] Anna Rossi")).toBeLessThan(text.indexOf("] Luca Bianchi"));
    expect(text).not.toMatch(/Seen|Reply with quote|More actions/);
    expect(errors).toEqual([]);
  });

  it("copies the complete message when only one word is selected", async () => {
    await page.locator(bubble(1)).click();
    await page.locator(bubble(1)).evaluate((el) => {
      const text = el.lastChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 3);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    await page.keyboard.press("Control+c");
    await expect.poll(async () => (await clipboard())["text/plain"]).toContain("\nAnswer\n");
  });

  it("keeps composer, outside and mixed-page selections native", async () => {
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    await box.fill("Unsent draft");
    await box.selectText();
    await page.keyboard.press("Control+c");
    expect((await clipboard())["text/plain"]).toBe("Unsent draft");
    await page.locator("#outside").click();
    await select("#outside");
    await page.keyboard.press("Control+c");
    expect((await clipboard())["text/plain"]).toBe("Outside text");
    await select(bubble(0), "#outside");
    await page.keyboard.press("Control+c");
    expect((await clipboard())["text/plain"]).not.toContain("Teams chat:");
  });

  it("uses native copy for Ctrl+Shift+C", async () => {
    await page.locator(bubble(0)).click();
    await select(bubble(0));
    await page.keyboard.press("Control+Shift+c");
    expect((await clipboard())["text/plain"]).toBe("Question");
    await page.keyboard.press("Control+c");
    await expect.poll(async () => (await clipboard())["text/plain"]).toContain("Teams chat:");
  });

  it("copies image-only messages as embedded original image data", async () => {
    await page.locator(`[data-mid="${rows[2].mid}"]`).getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Copy message" }).click();
    await expect.poll(async () => (await clipboard())["text/html"]).toContain("data:image/png;base64,");
    expect((await clipboard())["text/plain"]).toContain("[image 1]");
    expect(errors).toEqual([]);
  });

  it("marks an unavailable image without losing the message", async () => {
    await page.route("**/media/sample.png?*", (route) => route.fulfill({ status: 404 }));
    await page.locator(`[data-mid="${rows[2].mid}"]`).getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Copy message" }).click();
    await expect.poll(async () => (await clipboard())["text/plain"]).toContain("[image 1: not available]");
    expect((await clipboard())["text/html"]).not.toContain("<img");
  });

  it("does not replace a newer composer copy when an image finishes late", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/media/sample.png?*", async (route) => {
      await ready;
      await route.fulfill({ contentType: "image/png", body: PNG });
    });
    await page.evaluate(() => {
      const write = navigator.clipboard.write.bind(navigator.clipboard);
      (window as unknown as { copySettled: boolean }).copySettled = false;
      navigator.clipboard.write = async (items) => {
        try { await write(items); }
        finally { (window as unknown as { copySettled: boolean }).copySettled = true; }
      };
    });
    await page.locator(`[data-mid="${rows[2].mid}"]`).getByRole("button", { name: "More actions" }).click();
    const fetching = page.waitForRequest("**/media/sample.png?*");
    await page.getByRole("menuitem", { name: "Copy message" }).click();
    await fetching;
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    await box.fill("Newer draft copy");
    await box.selectText();
    await page.keyboard.press("Control+c");
    release();
    await page.waitForFunction(() => (window as unknown as { copySettled: boolean }).copySettled);
    expect((await clipboard())["text/plain"]).toBe("Newer draft copy");
  });

  it("uses the touch sheet copy action", async () => {
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query) => query === "(hover: none)" ? { ...original(query), matches: true, addEventListener() {}, removeEventListener() {} } : original(query);
    });
    await page.evaluate((rows) => (window as unknown as { setView: (v: unknown) => void }).setView({ rows: [...rows], open: { id: 41, status: "done" } }), rows);
    await page.locator(bubble(1)).click();
    await page.getByRole("button", { name: "Copy message", exact: true }).click();
    await expect.poll(async () => (await clipboard())["text/plain"]).toContain("Luca Bianchi");
    expect(errors).toEqual([]);
  });
});
