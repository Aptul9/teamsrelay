// The Change server entries of the web app in the local Google Chrome, headless: the account menu item and the link of
// the sign-in page lead back to the start page of the Android app (http://tauri.localhost/#change, answered by the
// test), and only when the app opened the server.
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const START = "http://tauri.localhost/";
const APP = encodeURIComponent(START);

let js = "";
let browser: Browser;

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(__dirname, "change-server-page.tsx")],
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

// The test page at http://app.test; kept: the start page this device kept from an earlier visit
async function open(url: string, kept?: string) {
  const context = await browser.newContext();
  await context.route("http://app.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="root"></div><script>${js}</script></body></html>` }),
  );
  await context.route(`${START}**`, (route) => route.fulfill({ contentType: "text/html", body: "<title>start page</title>" }));
  if (kept) await context.addInitScript((v) => localStorage.setItem("appstart", v), kept);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  return { page, errors, close: () => context.close() };
}

describe("Change server", () => {
  it("is in the account menu when the Android app opened the server, and brings back the form of its start page", async () => {
    const { page, errors, close } = await open(`http://app.test/menu?app=${APP}`);
    await page.getByRole("button", { name: /Accounts and settings/ }).click();
    await Promise.all([page.waitForURL(`${START}#change`), page.getByRole("menuitem", { name: "Change server" }).click()]);
    expect(errors).toEqual([]);
    await close();
  });

  it("is in the account menu as the device kept it, when the server page loads without it", async () => {
    const { page, close } = await open("http://app.test/menu", START);
    await page.getByRole("button", { name: /Accounts and settings/ }).click();
    expect(await page.getByRole("menuitem", { name: "Change server" }).getAttribute("href")).toBe(`${START}#change`);
    await close();
  });

  it("is not in the account menu of a browser, nor for an address other than the app's", async () => {
    for (const url of ["http://app.test/menu", `http://app.test/menu?app=${encodeURIComponent("https://evil.example/")}`]) {
      const { page, close } = await open(url);
      await page.getByRole("button", { name: /Accounts and settings/ }).click();
      await page.getByRole("menuitem", { name: "Sign out" }).waitFor();
      expect(await page.getByRole("menuitem", { name: "Change server" }).count()).toBe(0);
      await close();
    }
  });

  it("is on the sign-in page the app reached without a session, and brings back the form of its start page", async () => {
    const { page, errors, close } = await open(`http://app.test/login?next=${encodeURIComponent(`/?app=${APP}`)}`);
    await Promise.all([page.waitForURL(`${START}#change`), page.getByRole("link", { name: "Change server" }).click()]);
    expect(errors).toEqual([]);
    await close();
  });

  it("is not on the sign-in page of a browser", async () => {
    const { page, close } = await open("http://app.test/login?next=%2F");
    await page.getByRole("button", { name: "Sign in" }).waitFor();
    expect(await page.getByRole("link", { name: "Change server" }).count()).toBe(0);
    await close();
  });
});
