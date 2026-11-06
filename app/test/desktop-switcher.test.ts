// The desktop tab (/remote) in the local Google Chrome, headless: the one desktop on the whole page, a small tab with an
// arrow at the top that pulls down the accounts, and a pick brings another account to the front on the desktop already
// on screen (POST /api/desktop/N, answered by the test), with no new load of the desktop.
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COUNTS_EVERY_MS } from "@/components/DesktopSwitcher";
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
// answer: what the route answers to a POST; seen: the seen lists this device stored before (localStorage); clock: a
// clock the test moves; served.accounts: what /api/accounts answers
async function open(
  url: string,
  answer: { status: number; body: unknown } = { status: 200, body: { ok: true, shown: true } },
  { seen = {}, clock = false }: { seen?: Record<string, string>; clock?: boolean } = {},
) {
  const context = await browser.newContext();
  const loads: number[] = [];
  const posts: number[] = [];
  const served = { accounts: [] as unknown[] };
  await context.addInitScript((stored) => {
    if (window !== window.top || location.pathname !== "/remote") return;
    for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v);
  }, seen);
  await context.route("http://app.test/**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/api/accounts") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ accounts: served.accounts, max: null }) });
    if (u.pathname === "/blank") return route.fulfill({ contentType: "text/html", body: "<title>blank</title>" });
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
  if (clock) await page.clock.install();
  await page.goto(url);
  await page.frameLocator("iframe").locator("p").waitFor();
  const arrow = page.getByRole("button", { name: /^Accounts(,|$)/ });
  const shown = async () => (await arrow.getAttribute("aria-expanded")) === "true";
  // the accounts of the tab, as a user can reach them: none while it is up
  const picks = async () => page.locator("#desktop-accounts").getByRole("button").allInnerTexts();
  const pressed = async () => page.locator('#desktop-accounts button[aria-pressed="true"]').innerText();
  const frame = async () => page.locator("iframe").getAttribute("src");
  return { context, page, errors, loads, posts, served, arrow, shown, picks, pressed, frame, close: () => context.close() };
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

describe("what waits in the accounts, on the desktop tab", () => {
  // this device saw n1 of account 1 and c1 of account 2; n2 and c2 came later
  const seen = { "actseen:1:1790000000": '["n1"]', "actcalls:1:1790000000": "1", "actseen:2:1790000000": '["c1"]', "actcalls:2:1790000000": "1" };
  const counts = (page: Page, where: string) => page.locator(where).locator("[title]").evaluateAll((els) => els.map((e) => e.getAttribute("title")));

  it("shows on the arrow what waits in every account, and on each account the counts of the account menu", async () => {
    const { page, errors, arrow, close } = await open("http://app.test/remote?account=2&counts", undefined, { seen });

    // 2 chats + 1 notification of account 1, 1 chat of the relay account; the stopped account counts nothing
    expect(await arrow.getAttribute("aria-label")).toBe("Accounts, 3 unread chats, 1 new notification, 1 missed call");
    expect(await arrow.locator("[title]").evaluateAll((els) => els.map((e) => e.firstChild?.textContent))).toEqual(["4", "1"]);

    await arrow.click();

    expect(await counts(page, '#desktop-accounts button:has-text("Contoso Cruises")')).toEqual(["2 unread chats, 1 new notification"]);
    expect(await counts(page, '#desktop-accounts button:has-text("User Test")')).toEqual(["1 missed call"]);
    // the relay account has no window on the desktop: its count stands under the buttons
    const elsewhere = page.locator("[data-elsewhere]");
    expect(await elsewhere.innerText()).toMatch(/^Not on the desktop:\s*Relay Srl/);
    expect(await counts(page, "[data-elsewhere]")).toEqual(["1 unread chat"]);
    expect(errors).toEqual([]);
    await close();
  });

  it("drops a count the app marks seen in another tab, at once", async () => {
    const { context, page, arrow, close } = await open("http://app.test/remote?account=2&counts", undefined, { seen });
    await arrow.click();

    const app = await context.newPage();
    await app.goto("http://app.test/blank");
    await app.evaluate(() => localStorage.setItem("actseen:1:1790000000", '["n2","n1"]'));

    await expect.poll(() => counts(page, '#desktop-accounts button:has-text("Contoso Cruises")')).toEqual(["2 unread chats"]);
    await close();
  });

  it("reads the accounts again every so often for a new count", async () => {
    const { page, served, arrow, close } = await open("http://app.test/remote?account=2&counts", undefined, { seen, clock: true });
    served.accounts = await page.evaluate(() => {
      const accounts = (window as unknown as { fixture: Array<Record<string, unknown>> }).fixture;
      return accounts.map((a) => (a.slot === 2 ? { ...a, missedCalls: ["c3", "c2", "c1"], activityIds: ["c3", "c2", "c1"] } : a));
    });

    await page.clock.runFor(COUNTS_EVERY_MS);

    await expect.poll(() => arrow.getAttribute("aria-label")).toBe("Accounts, 3 unread chats, 1 new notification, 2 missed calls");
    await close();
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
