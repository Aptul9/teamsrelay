// The presence of a person on their picture in the chat list, in the local Google Chrome, headless: a dot named by the
// presence, none when the agent saw none, and the crossed bell of a muted chat kept apart from it.
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(__dirname, "avatar-presence-page.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: path.join(__dirname, "../tsconfig.json"),
    logLevel: "silent",
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body><div id="root"></div><script>${out.outputFiles[0].text}</script></body></html>`);
  await page.locator("#muted-away").waitFor();
});

afterAll(async () => {
  await browser?.close();
});

const dot = (id: string) => page.locator(`#${id} [data-presence]`);

describe("the picture of a person", () => {
  it("carries a dot named by the presence Teams shows", async () => {
    const words = { available: "Available", busy: "Busy", dnd: "Do not disturb", away: "Away", offline: "Offline", ooo: "Out of office" };
    for (const [p, word] of Object.entries(words)) {
      expect(await dot(p).getAttribute("data-presence"), p).toBe(p);
      expect(await page.locator(`#${p}`).getByRole("img", { name: word }).count(), p).toBe(1);
    }
  });

  it("has no dot when the agent saw no presence, or one it does not know", async () => {
    for (const id of ["none", "unknown", "muted"]) expect(await dot(id).count(), id).toBe(0);
  });

  it("keeps the crossed bell of a muted chat, apart from the dot", async () => {
    expect(await page.locator("#muted").getByLabel("Muted").count()).toBe(1);
    expect(await page.locator("#muted-away").getByLabel("Muted").count()).toBe(1);
    expect(await dot("muted-away").getAttribute("data-presence")).toBe("away");
  });
});
