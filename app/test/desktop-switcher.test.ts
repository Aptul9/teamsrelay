// The desktop tab (/remote) in the local Google Chrome, headless: the one desktop on the whole page, a small tab with an
// arrow at the top that pulls down the accounts, and a pick brings another account to the front on the desktop already
// on screen (POST /api/desktop/N, answered by the test), with no new load of the desktop.
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESKTOP_TAB, desktopTarget } from "@/lib/client";

let js = "";
let browser: Browser;

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(__dirname, "desktop-switcher-page.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: path.join(__dirname, "../tsconfig.json"),
    alias: { "next/link": path.join(__dirname, "next-link-stub.tsx") },
    logLevel: "silent",
  });
  js = out.outputFiles[0].text;
  browser = await chromium.launch({ channel: "chrome", headless: true });
});

afterAll(async () => {
  await browser?.close();
});

// The page at http://app.test/remote; the desktop loads, and the POSTs of the switcher, are counted per account.
// answer: what the route answers to a POST
async function open(url: string, answer: { status: number; body: unknown } = { status: 200, body: { ok: true, shown: true } }) {
  const context = await browser.newContext();
  const loads: number[] = [];
  const posts: number[] = [];
  await context.route("http://app.test/**", (route) => {
    const u = new URL(route.request().url());
    const desk = /^\/api\/desktop\/(\d+)$/.exec(u.pathname);
    if (desk && route.request().method() === "POST") {
      posts.push(Number(desk[1]));
      return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
    }
    if (desk) {
      loads.push(Number(desk[1]));
      return route.fulfill({ contentType: "text/html", body: "<title>desktop</title><p>desktop</p>" });
    }
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="root"></div><script>${js}</script></body></html>` });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.frameLocator("iframe").locator("p").waitFor();
  const arrow = page.getByRole("button", { name: "Accounts", exact: true });
  const shown = async () => (await arrow.getAttribute("aria-expanded")) === "true";
  // the accounts of the tab, as a user can reach them: none while it is up
  const picks = async () => page.locator("#desktop-accounts").getByRole("button").allInnerTexts();
  const pressed = async () => page.locator('#desktop-accounts button[aria-pressed="true"]').innerText();
  const frame = async () => page.locator("iframe").getAttribute("src");
  return { page, errors, loads, posts, arrow, shown, picks, pressed, frame, close: () => context.close() };
}

describe("the desktop tab", () => {
  it("opens the desktop on the account asked for, with only the arrow of the tab over it", async () => {
    const { page, errors, loads, shown, picks, pressed, frame, close } = await open("http://app.test/remote?account=2");

    expect(await shown()).toBe(false);
    expect(await picks()).toEqual([]);
    expect(await pressed()).toBe("User Test");
    expect(await frame()).toBe("/api/desktop/2");
    expect(new URL(page.url()).search).toBe("?account=2");
    expect(loads).toEqual([2]);
    expect(errors).toEqual([]);
    await close();
  });

  it("pulls down the accounts whose window is on the desktop at a click on the arrow, and puts them away at the next", async () => {
    const { page, arrow, shown, picks, pressed, close } = await open("http://app.test/remote?account=2");

    await arrow.click();

    expect(await shown()).toBe(true);
    expect(await picks()).toEqual(["Contoso Cruises", "User Test"]);
    expect(await pressed()).toBe("User Test");
    // the arrow is under the accounts now, pointing up
    const [list, tab] = await Promise.all([page.locator("#desktop-accounts").boundingBox(), arrow.boundingBox()]);
    expect(tab!.y).toBeGreaterThanOrEqual(list!.y + list!.height - 1);

    await arrow.click();

    await expect.poll(shown).toBe(false);
    expect(await picks()).toEqual([]);
    await close();
  });

  it("puts the accounts away at a click anywhere else, the desktop included, and at Escape", async () => {
    const { page, arrow, shown, close } = await open("http://app.test/remote?account=2");

    await arrow.click();
    await page.frameLocator("iframe").locator("p").click();
    await expect.poll(shown).toBe(false);

    await arrow.click();
    await page.keyboard.press("Escape");
    await expect.poll(shown).toBe(false);
    await close();
  });

  it("brings the account picked to the front on the desktop already on screen, and the address follows it", async () => {
    const { page, errors, loads, posts, arrow, shown, pressed, frame, close } = await open("http://app.test/remote?account=2");

    await arrow.click();
    await page.getByRole("button", { name: "Contoso Cruises" }).click();

    await expect.poll(shown).toBe(false);
    expect(posts).toEqual([1]);
    expect(await pressed()).toBe("Contoso Cruises");
    expect(new URL(page.url()).search).toBe("?account=1");
    expect(await frame()).toBe("/api/desktop/2");
    expect(loads).toEqual([2]);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("IFRAME");
    expect(errors).toEqual([]);

    // a reload opens the account in front
    await page.reload();
    await page.frameLocator("iframe").locator("p").waitFor();
    expect(await frame()).toBe("/api/desktop/1");
    expect(await pressed()).toBe("Contoso Cruises");
    await close();
  });

  it("keeps the account in front and says why when the one picked could not be brought forward", async () => {
    for (const answer of [
      { status: 503, body: { detail: "Account not ready yet" } },
      { status: 200, body: { ok: true, shown: false } },
    ]) {
      const { page, posts, arrow, shown, pressed, close } = await open("http://app.test/remote?account=2", answer);

      await arrow.click();
      await page.getByRole("button", { name: "Contoso Cruises" }).click();

      await expect.poll(() => page.locator("#desktop-accounts").getByRole("alert").innerText()).toMatch(/Contoso Cruises/);
      expect(posts).toEqual([1]);
      expect(await shown()).toBe(true);
      expect(await pressed()).toBe("User Test");
      expect(new URL(page.url()).search).toBe("?account=2");
      await close();
    }
  });

  it("opens on the first account of the desktop when the one asked for is not there, and says so in the address", async () => {
    for (const url of ["http://app.test/remote?account=3", "http://app.test/remote"]) {
      const { page, pressed, frame, close } = await open(url);
      expect(await pressed()).toBe("Contoso Cruises");
      expect(await frame()).toBe("/api/desktop/1");
      expect(new URL(page.url()).search).toBe("?account=1");
      await close();
    }
  });
});

describe("opening the desktop from the app on a PC", () => {
  it("goes to the desktop tab of the one desktop, reused by the next opening", () => {
    expect(desktopTarget("/api/desktop/{n}", 2)).toEqual({ url: "/remote?account=2", target: DESKTOP_TAB });
  });

  it("goes to the address of another desktop in a new tab", () => {
    expect(desktopTarget("https://desk.example/{n}/", 2)).toEqual({ url: "https://desk.example/2/", target: "_blank" });
  });
});
