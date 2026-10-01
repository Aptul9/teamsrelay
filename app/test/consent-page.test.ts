// The consent screen of an MCP client, in the local Google Chrome, headless: it names the client and the user, Allow
// and Deny post the answer with the signed query of the page, and the page follows where better-auth sends it. A
// query that is not signed shows no buttons.
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OAuthConsentProps } from "@/components/OAuthConsent";

let browser: Browser;
let page: Page;
let js: string;
const errors: string[] = [];
const posted: { url: string; body: unknown; origin: string | null }[] = [];
const QUERY = "response_type=code&client_id=abc&scope=openid+offline_access&exp=1&sig=xyz";

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(__dirname, "consent-page.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: path.join(__dirname, "../tsconfig.json"),
    logLevel: "silent",
  });
  js = out.outputFiles[0].text;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://consent.test/**", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      posted.push({ url: req.url(), body: req.postDataJSON(), origin: await req.headerValue("origin") });
      const accept = (req.postDataJSON() as { accept: boolean }).accept;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ redirect: true, url: `http://consent.test/back?${accept ? "code=c1" : "error=access_denied"}` }) });
    }
    if (new URL(req.url()).pathname === "/back") return route.fulfill({ contentType: "text/html", body: "<p>back at the client</p>" });
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="root"></div><script>${js}</script></body></html>` });
  });
});

afterAll(async () => {
  await browser?.close();
});

const props: OAuthConsentProps = { client: { name: "Claude Code", uri: "" }, user: { name: "Administrator", email: "admin@teamsrelay.test" }, scopes: ["openid", "offline_access"], signed: true };

async function open(p: OAuthConsentProps) {
  await page.goto(`http://consent.test/consent?${QUERY}`);
  await page.waitForFunction(() => typeof (window as Window & { show?: unknown }).show === "function");
  await page.evaluate((v) => (window as unknown as { show: (x: OAuthConsentProps) => void }).show(v), p);
}

describe("the consent screen", () => {
  it("names the client, the user, and what the client gets", async () => {
    await open(props);
    const text = await page.locator("body").innerText();
    expect(text).toContain("Claude Code");
    expect(text).toContain("admin@teamsrelay.test");
    expect(text).toMatch(/Teams chats/);
    expect(text).toMatch(/browser/);
  });

  it("Allow posts accept true with the signed query of the page, then follows to the client", async () => {
    posted.length = 0;
    await open(props);
    await page.getByRole("button", { name: "Allow" }).click();
    await page.waitForURL("http://consent.test/back?code=c1");
    expect(posted).toEqual([{ url: "http://consent.test/api/auth/oauth2/consent", body: { accept: true, oauth_query: QUERY }, origin: "http://consent.test" }]);
  });

  it("Deny posts accept false", async () => {
    posted.length = 0;
    await open(props);
    await page.getByRole("button", { name: "Deny" }).click();
    await page.waitForURL("http://consent.test/back?error=access_denied");
    expect(posted.map((p) => p.body)).toEqual([{ accept: false, oauth_query: QUERY }]);
  });

  it("shows an error and no buttons for a query that is not signed, or a client that does not exist", async () => {
    for (const p of [{ ...props, signed: false }, { ...props, client: null }]) {
      await open(p);
      await expect.poll(() => page.locator("body").innerText()).toMatch(/not valid|expired/i);
      expect(await page.getByRole("button", { name: "Allow" }).count()).toBe(0);
    }
    expect(errors).toEqual([]);
  });
});
