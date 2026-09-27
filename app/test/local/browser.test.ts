// The relay browser on a profile in another language: an Italian Windows gives the profile Italian languages, Teams
// then answers in Italian, and the page scripts read English (selectors.ts). The real launcher on a headless Chrome;
// Teams is a route of the browser context, nothing reaches it.
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser } from "@/local/browser";
import { tempDir } from "../helpers";

let context: BrowserContext;
let acceptLanguage = "";

beforeAll(async () => {
  const profileDir = path.join(tempDir("teamsrelay-browser-"), "profile");
  // the language settings a Windows set to Italian leaves in a new profile
  fs.mkdirSync(path.join(profileDir, "Default"), { recursive: true });
  fs.writeFileSync(path.join(profileDir, "Default", "Preferences"), JSON.stringify({ intl: { accept_languages: "it-IT,it", selected_languages: "it-IT,it" } }));
  context = await launchBrowser({ profileDir, channel: "chrome", headless: true });
  await context.route("https://teams.cloud.microsoft/**", async (r) => {
    // allHeaders: headers() leaves out the ones the network stack adds, Accept-Language among them
    acceptLanguage = (await r.request().allHeaders())["accept-language"] ?? "";
    return r.fulfill({ contentType: "text/html", body: "<!doctype html><title>Teams</title>" });
  });
}, 60_000);

afterAll(async () => {
  await context?.close();
});

describe("relay browser", () => {
  it("shows Teams in English on a profile set to another language", async () => {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://teams.cloud.microsoft/");
    const seen = await page.evaluate(() => ({ language: navigator.language, dates: new Intl.DateTimeFormat().resolvedOptions().locale }));
    expect({ ...seen, acceptLanguage }).toEqual({ language: "en-US", dates: "en-US", acceptLanguage: expect.stringMatching(/^en-US\b/) });
  }, 60_000);
});
