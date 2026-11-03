// The dashboard of a status page in the local Google Chrome, headless, with the CSS of the app: every section at 375,
// 768, 1024 and 1440 px in light and dark, no horizontal scroll, the values of a segment and of a heat map cell on
// keyboard focus. TR_SHOTS=<dir> writes a screenshot of each width and theme there.
import fs from "node:fs";
import path from "node:path";
import tailwind from "@tailwindcss/postcss";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import postcss from "postcss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayStart } from "@/lib/status-stats";

const APP = path.join(__dirname, "..");
const NOW = dayStart("2026-11-05", "Europe/Rome") + 15.5 * 3600;
let html = "";
let browser: Browser;

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(__dirname, "status-page.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: path.join(APP, "tsconfig.json"),
    logLevel: "silent",
  });
  const globals = path.join(APP, "src/app/globals.css");
  const css = await postcss([tailwind({ base: APP })]).process(fs.readFileSync(globals, "utf8"), { from: globals });
  html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css.css}</style></head><body><div id="root"></div><script>${out.outputFiles[0].text}</script></body></html>`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function open(width: number, theme: "light" | "dark"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
  await page.clock.setFixedTime(new Date(NOW * 1000));
  await page.setContent(html.replace('<html lang="en">', `<html lang="en" class="${theme}">`));
  await page.getByRole("heading", { name: "Camilla Marini" }).waitFor();
  return page;
}

const SECTIONS = ["Now", "Today", "Challenge at a glance", "Hours per day", "Scoreboard", "Data per day"];

describe("the dashboard of a status page", () => {
  for (const width of [375, 768, 1024, 1440]) {
    for (const theme of ["light", "dark"] as const) {
      it(`shows every section with no horizontal scroll at ${width} px, ${theme}`, async () => {
        const page = await open(width, theme);
        for (const s of SECTIONS) expect(await page.getByRole("heading", { name: s, exact: true }).isVisible(), s).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        if (process.env.TR_SHOTS) {
          fs.mkdirSync(process.env.TR_SHOTS, { recursive: true });
          await page.screenshot({ path: path.join(process.env.TR_SHOTS, `status-${width}-${theme}.png`), fullPage: true });
        }
        await page.close();
      });
    }
  }

  it("keeps no horizontal scroll on a phone in landscape and with text at 200%", async () => {
    const page = await open(844, "dark");
    await page.setViewportSize({ width: 844, height: 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
    const wide = await page.evaluate(() =>
      // what overflows the page; the table scrolls inside its own box
      [...document.querySelectorAll("body *")]
        .filter((e) => !e.parentElement?.closest(".overflow-x-auto") && e.getBoundingClientRect().right > window.innerWidth + 0.5)
        .map((e) => `${e.tagName}.${e.getAttribute("class")?.slice(0, 60)} ${e.textContent?.slice(0, 30)}`),
    );
    expect(wide).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("region", { name: "Today" }).getByRole("img").first().focus();
    if (process.env.TR_SHOTS) await page.screenshot({ path: path.join(process.env.TR_SHOTS, "status-375-dark-200pct-focus.png"), fullPage: true });
    await page.close();
  });

  it("says the status now, since when and for how long", async () => {
    const page = await open(375, "light");
    const now = page.getByRole("region", { name: "Now" });
    expect(await now.getByText("Available", { exact: true }).isVisible()).toBe(true);
    expect(await now.textContent()).toContain("since 13:00");
    expect(await now.textContent()).toContain("2 h 30 min");
    await page.close();
  });

  it("gives the status, from, to and duration of a segment of today on keyboard focus", async () => {
    const page = await open(1024, "light");
    const today = page.getByRole("region", { name: "Today" });
    await today.getByRole("img", { name: /^Busy, 10:15 to 12:00/ }).focus();
    expect(await today.getByTestId("readout").textContent()).toBe("Busy · 10:15 to 12:00 · 1 h 45 min");
    await page.keyboard.press("Tab");
    expect(await today.getByTestId("readout").textContent()).toBe("Away · 12:00 to 13:00 · 1 h");
    await page.close();
  });

  it("gives the status of an hour of the heat map on keyboard focus, arrows moving along", async () => {
    const page = await open(1024, "dark");
    const glance = page.getByRole("region", { name: "Challenge at a glance" });
    await glance.getByRole("img", { name: /^Tuesday 3 November, 14:00 to 15:00/ }).focus();
    expect(await glance.getByTestId("readout").textContent()).toBe("Tuesday 3 November · 14:00 to 15:00 · Do not disturb");
    await page.keyboard.press("ArrowRight");
    expect(await glance.getByTestId("readout").textContent()).toBe("Tuesday 3 November · 15:00 to 16:00 · Do not disturb");
    await page.keyboard.press("ArrowRight");
    expect(await glance.getByTestId("readout").textContent()).toBe("Tuesday 3 November · 16:00 to 17:00 · Available");
    await page.close();
  });

  it("writes what each chart shows in words, and keeps every number in the table", async () => {
    const page = await open(375, "light");
    expect(await page.getByRole("region", { name: "Today" }).textContent()).toMatch(/Mostly available so far/);
    await page.getByText("Data per day").click();
    const rows = page.getByRole("table").getByRole("row");
    expect(await rows.count()).toBe(5);
    expect(await rows.nth(1).textContent()).toContain("08:47");
    await page.close();
  });
});
