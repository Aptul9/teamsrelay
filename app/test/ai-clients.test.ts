// The AI clients card of Settings in the local Google Chrome, headless, with the server played by the test: the clients
// the user allowed and Revoke (asked first), and for each account on another computer the switch of its browser and
// its last actions.
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let browser: Browser;
let page: Page;
const errors: string[] = [];
const requests: string[] = [];
let clients = [
  { clientId: "c-code", name: "Claude Code", since: "2026-10-01T10:00:00.000Z" },
  { clientId: "c-open", name: "opencode", since: "2026-10-01T11:00:00.000Z" },
];
let off = false;
const account = (slot: number, relay: boolean, host: string) => ({ slot, name: `User ${slot}`, email: `u${slot}@contoso.example`, tenant: "Contoso", av: "", relay, host, stopped: false });

beforeAll(async () => {
  const out = await build({
    entryPoints: [path.join(__dirname, "ai-clients-page.tsx")],
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
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://app.test/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const send = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (u.pathname !== "/") requests.push(`${req.method()} ${u.pathname}${req.postData() ? ` ${req.postData()}` : ""}`);
    if (u.pathname === "/api/accounts") return send({ accounts: [account(1, true, "PC B"), account(2, false, "")] });
    if (u.pathname === "/api/accounts/1/browser" && req.method() === "GET")
      return send({
        off,
        connected: true,
        actions: [
          { ts: Date.parse("2026-10-01T18:05:00Z"), client: "Claude Code", tool: "browser_navigate", host: "www.wikipedia.org", outcome: "ok" },
          { ts: Date.parse("2026-10-01T18:04:00Z"), client: "Claude Code", tool: "browser_snapshot", host: "", outcome: "error" },
        ],
      });
    if (u.pathname === "/api/accounts/1/browser" && req.method() === "PATCH") {
      off = (req.postDataJSON() as { off: boolean }).off;
      return send({ ok: true, off });
    }
    if (u.pathname === "/api/oauth/clients") return send({ clients });
    if (u.pathname.startsWith("/api/oauth/clients/") && req.method() === "DELETE") {
      clients = clients.filter((c) => c.clientId !== decodeURIComponent(u.pathname.split("/").pop()!));
      return send({ ok: true });
    }
    if (u.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="root"></div><script>${js}</script></body></html>` });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://app.test/");
});

afterAll(async () => {
  await browser?.close();
});

describe("AI clients in Settings", () => {
  it("lists the clients the user allowed", async () => {
    await expect.poll(() => page.locator("body").innerText()).toContain("opencode");
    const text = await page.locator("body").innerText();
    expect(text).toContain("Claude Code");
  });

  it("shows the last actions of the browser of an account on another computer: time, client, tool, host, outcome", async () => {
    await expect.poll(() => page.locator("body").innerText()).toContain("www.wikipedia.org");
    const rows = await page.locator("table tbody tr").allInnerTexts();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/Claude Code\s+browser_navigate\s+www\.wikipedia\.org\s+ok/);
    expect(rows[1]).toMatch(/browser_snapshot/);
    expect(rows[1]).toMatch(/error/);
    // the account of the browsers container has no browser for AI clients
    expect(await page.locator("body").innerText()).not.toContain("User 2");
  });

  it("switches the browser off with the switch, and on again", async () => {
    const sw = page.getByRole("switch", { name: /Browser of User 1/ });
    await expect.poll(() => sw.getAttribute("aria-checked")).toBe("true");
    await sw.click();
    await expect.poll(() => off).toBe(true);
    await expect.poll(() => sw.getAttribute("aria-checked")).toBe("false");
    await sw.click();
    await expect.poll(() => off).toBe(false);
  });

  it("revokes a client after asking", async () => {
    requests.length = 0;
    await page.getByRole("button", { name: "Revoke opencode" }).click();
    expect(requests.filter((r) => r.startsWith("DELETE"))).toEqual([]);
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
    await expect.poll(() => requests.filter((r) => r.startsWith("DELETE"))).toEqual(["DELETE /api/oauth/clients/c-open"]);
    await expect.poll(() => page.getByRole("button", { name: "Revoke opencode" }).count()).toBe(0);
    expect(errors).toEqual([]);
  });
});
