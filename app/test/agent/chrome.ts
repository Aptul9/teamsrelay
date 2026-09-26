import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll } from "vitest";

// Page scripts run in the local Google Chrome, present on GitHub-hosted Ubuntu runners as well.
export function withChrome() {
  const ctx = {} as { browser: Browser; page: Page };
  beforeAll(async () => {
    ctx.browser = await chromium.launch({ channel: "chrome", headless: true });
    ctx.page = await ctx.browser.newPage({ viewport: { width: 1280, height: 900 } });
  });
  afterAll(async () => {
    await ctx.browser?.close();
  });
  return ctx;
}

// HTML captured from Teams web (structure only, names and texts invented), see scripts/capture-fixture.ts
export function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

// Image of the given size, for naturalWidth checks
export const picture = (w: number, h = w) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#6b70dd"/></svg>`)}`;
