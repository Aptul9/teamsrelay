// The agent connects to the Chromium of its slot over CDP, the way the supervisor starts it: notifications are
// granted, every other permission stays with the browser, where the managed policy of the image gives the Teams
// origins the microphone of a call answered from the app.
import net from "node:net";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CdpBrowser } from "@/agent/cdp";
import { showsPage } from "@/agent/logic/hosts";
import { tempDir } from "../helpers";

let context: BrowserContext;
let page: Page;
let port = 0;

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: p } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return p;
}

const permissions = (p: Page) =>
  p.evaluate(() => Promise.all(["notifications", "microphone"].map((name) => navigator.permissions.query({ name: name as PermissionName }).then((s) => s.state))));

beforeAll(async () => {
  port = await freePort();
  context = await chromium.launchPersistentContext(path.join(tempDir(), "profile"), { channel: "chrome", headless: true, args: [`--remote-debugging-port=${port}`] });
  page = context.pages()[0] ?? (await context.newPage());
  await page.route("https://teams.microsoft.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto("https://teams.microsoft.com/v2/");
});

afterAll(async () => {
  await context?.close();
});

describe("CdpBrowser", () => {
  it("grants notifications and leaves the microphone to the browser", async () => {
    expect(await permissions(page)).toEqual(["prompt", "prompt"]);
    await new CdpBrowser(`http://127.0.0.1:${port}`).context();
    // a grant of notifications alone through Browser.grantPermissions denies the microphone on every origin
    expect(await permissions(page)).toEqual(["granted", "prompt"]);
  });
});

// After a federated sign-in Playwright can keep a stuck view of the tab: a page with no address that never answers,
// to every agent that connects again, while Chromium lists the tab on Teams. Only a browser started again shows it.
describe("stuck view of the tab", () => {
  it("tells a listed page that shows something from blank tabs", () => {
    expect(showsPage([{ type: "page", url: "https://teams.cloud.microsoft/" }])).toBe(true);
    expect(showsPage([{ type: "page", url: "about:blank" }, { type: "browser_ui", url: "chrome://omnibox-popup.top-chrome/" }])).toBe(false);
    expect(showsPage([{ type: "page", url: "" }, { type: "service_worker", url: "https://teams.cloud.microsoft/serviceworker.js" }])).toBe(false);
  });

  it("closes the browser when only blank tabs reach the agent while Chromium shows a page", async () => {
    const p = await freePort();
    const own = await chromium.launchPersistentContext(path.join(tempDir(), "stuck"), { channel: "chrome", headless: true, args: [`--remote-debugging-port=${p}`] });
    const tab = own.pages()[0] ?? (await own.newPage());
    await tab.route("https://teams.microsoft.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }));
    await tab.goto("https://teams.microsoft.com/v2/");
    const closed = new Promise<void>((resolve) => own.on("close", () => resolve()));
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    try {
      const cdp = new CdpBrowser(`http://127.0.0.1:${p}`);
      const ctx = await cdp.context();
      await cdp.noTeamsTab(ctx, { ms: 61_000, url: "" });
      expect(exit).toHaveBeenCalledWith(1);
      await closed;
    } finally {
      exit.mockRestore();
      await own.close().catch(() => undefined);
    }
  }, 30_000);

  it("leaves the browser alone while a sign-in page shows", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    try {
      const cdp = new CdpBrowser(`http://127.0.0.1:${port}`);
      const ctx = await cdp.context();
      await cdp.noTeamsTab(ctx, { ms: 61_000, url: "https://login.ourtesco.com/trust/" });
      expect(exit).toHaveBeenCalledWith(1);
      expect(page.isClosed()).toBe(false);
      expect(await page.evaluate(() => location.hostname)).toBe("teams.microsoft.com");
    } finally {
      exit.mockRestore();
    }
  }, 30_000);
});
