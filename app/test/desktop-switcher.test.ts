// The desktop tab (/remote) in the local Google Chrome, headless: a button per account above the one desktop, and a
// click brings another account to the front on the desktop already on screen (POST /api/desktop/N, answered by the
// test), with no new load of the desktop.
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
  const pressed = async () => page.locator('button[aria-pressed="true"]').innerText();
  const frame = async () => page.locator("iframe").getAttribute("src");
  return { page, errors, loads, posts, pressed, frame, close: () => context.close() };
}

describe("the desktop tab", () => {
  it("opens the desktop on the account asked for, with a button for each account whose window is on it", async () => {
    const { page, errors, loads, pressed, frame, close } = await open("http://app.test/remote?account=2");

    expect(await page.getByRole("button").allInnerTexts()).toEqual(["Contoso Cruises", "User Test"]);
    expect(await pressed()).toBe("User Test");
    expect(await frame()).toBe("/api/desktop/2");
    expect(loads).toEqual([2]);
    expect(errors).toEqual([]);
    await close();
  });

  it("brings another account to the front on the desktop already on screen, and gives the keyboard back to it", async () => {
    const { page, errors, loads, posts, pressed, frame, close } = await open("http://app.test/remote?account=2");

    await page.getByRole("button", { name: "Contoso Cruises" }).click();

    await expect.poll(pressed).toBe("Contoso Cruises");
    expect(posts).toEqual([1]);
    expect(await frame()).toBe("/api/desktop/2");
    expect(loads).toEqual([2]);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("IFRAME");
    expect(errors).toEqual([]);
    await close();
  });

  it("keeps the account in front and says why when the other one could not be brought forward", async () => {
    for (const answer of [
      { status: 503, body: { detail: "Account not ready yet" } },
      { status: 200, body: { ok: true, shown: false } },
    ]) {
      const { page, posts, pressed, close } = await open("http://app.test/remote?account=2", answer);

      await page.getByRole("button", { name: "Contoso Cruises" }).click();

      await expect.poll(() => page.getByRole("alert").innerText()).toMatch(/Contoso Cruises/);
      expect(posts).toEqual([1]);
      expect(await pressed()).toBe("User Test");
      await close();
    }
  });

  it("opens on the first account of the desktop when the one asked for is not there", async () => {
    for (const url of ["http://app.test/remote?account=3", "http://app.test/remote"]) {
      const { pressed, frame, close } = await open(url);
      expect(await pressed()).toBe("Contoso Cruises");
      expect(await frame()).toBe("/api/desktop/1");
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
