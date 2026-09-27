// The relay browser on a profile in another language: an Italian Windows gives the profile Italian languages, Teams
// then answers in Italian, and the page scripts read English (selectors.ts). The real launcher on a headless Chrome,
// against a local server that stands for Teams: the language the page and a worker of it report, and the
// Accept-Language the server receives for each of them.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser } from "@/local/browser";
import { tempDir } from "../helpers";

const PAGE = `<!doctype html><title>Teams</title><script>
  const worker = new Worker("/worker.js");
  window.fromWorker = new Promise((resolve) => (worker.onmessage = (e) => resolve(e.data)));
</script>`;
const WORKER = "postMessage(navigator.language)";

let context: BrowserContext;
let server: http.Server;
let url = "";
const accepted: Record<string, string> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    accepted[req.url ?? ""] = req.headers["accept-language"] ?? "";
    const worker = req.url === "/worker.js";
    res.writeHead(200, { "Content-Type": worker ? "text/javascript" : "text/html" });
    res.end(worker ? WORKER : PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const profileDir = path.join(tempDir("teamsrelay-browser-"), "profile");
  // the language settings a Windows set to Italian leaves in a new profile
  fs.mkdirSync(path.join(profileDir, "Default"), { recursive: true });
  fs.writeFileSync(path.join(profileDir, "Default", "Preferences"), JSON.stringify({ intl: { accept_languages: "it-IT,it", selected_languages: "it-IT,it" } }));
  context = await launchBrowser({ profileDir, channel: "chrome", headless: true });
}, 60_000);

afterAll(async () => {
  await context?.close();
  await new Promise((resolve) => server?.close(resolve));
});

describe("relay browser", () => {
  it("gives Teams English on a profile set to another language, in its workers too", async () => {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url);
    const seen = {
      page: await page.evaluate(() => navigator.language),
      worker: await page.evaluate(() => (window as unknown as { fromWorker: Promise<string> }).fromWorker),
      pageHeader: accepted["/"],
      workerHeader: accepted["/worker.js"],
    };
    expect(seen).toEqual({ page: "en-US", worker: "en-US", pageHeader: expect.stringMatching(/^en-US\b/), workerHeader: expect.stringMatching(/^en-US\b/) });
  }, 60_000);
});
