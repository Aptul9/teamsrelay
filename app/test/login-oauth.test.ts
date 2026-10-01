// The sign-in page in the local Google Chrome, headless, when an MCP client signs in (OAuth): better-auth sent the
// browser here with a signed query; the sign-in carries it (oauth_query) and the page follows better-auth to the consent
// screen instead of the app. A plain sign-in still goes to the app.
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let browser: Browser;
let page: Page;
const bodies: Record<string, unknown>[] = [];
// a query as better-auth signs it: the names of the signed parameters in ba_param, then sig
const signed = new URLSearchParams({ response_type: "code", client_id: "abc", scope: "openid", exp: "1", ba_iat: "1" });
for (const name of [...signed.keys(), "ba_param"].sort()) signed.append("ba_param", name);
signed.append("sig", "xyz");
const QUERY = signed.toString();

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(__dirname, "login-oauth-page.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: path.join(__dirname, "../tsconfig.json"),
    logLevel: "silent",
  });
  const js = out.outputFiles[0].text;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
  await page.route("http://app.test/**", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === "/api/auth/sign-in/email") {
      const body = req.postDataJSON() as Record<string, unknown>;
      bodies.push(body);
      const oauth = typeof body.oauth_query === "string";
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(oauth ? { redirect: true, url: `/consent?${QUERY}` } : { redirect: false, token: "t", user: { id: "u" } }) });
    }
    if (p === "/login") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="root"></div><script>${js}</script></body></html>` });
    return route.fulfill({ contentType: "text/html", body: `<title>${p}</title>` });
  });
});

afterAll(async () => {
  await browser?.close();
});

async function signIn(url: string) {
  bodies.length = 0;
  await page.goto(url);
  await page.getByLabel("Email").fill("admin@teamsrelay.test");
  await page.getByLabel("Password", { exact: true }).fill("local-admin-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
}

describe("sign-in of an MCP client", () => {
  it("sends the signed query with the sign-in and follows better-auth to the consent screen", async () => {
    await signIn(`http://app.test/login?${QUERY}`);
    await page.waitForURL(`http://app.test/consent?${QUERY}`);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].oauth_query).toBe(QUERY);
  });

  it("goes to the app after a plain sign-in", async () => {
    await signIn("http://app.test/login");
    await page.waitForURL("http://app.test/");
    expect(bodies[0]).not.toHaveProperty("oauth_query");
  });
});
