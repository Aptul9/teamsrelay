// The agent connects to the Chromium of its slot over CDP, the way the supervisor starts it: notifications are
// granted, every other permission stays with the browser, where the managed policy of the image gives the Teams
// origins the microphone of a call answered from the app.
import net from "node:net";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CdpBrowser } from "@/agent/cdp";
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
