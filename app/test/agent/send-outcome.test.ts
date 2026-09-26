// The send of the agent (teams/actions.ts) on a page that behaves like Teams (test/local/fake-teams.html): sent once
// Teams shows it, unconfirmed when it went out and Teams never shows it sent, failed when it never went out.
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SlotStore } from "@/agent/store/slot-store";
import { sendText } from "@/agent/teams/actions";
import { TeamsPage } from "@/agent/teams/page";
import { tempDir } from "../helpers";
import { withChrome } from "./chrome";

const FAKE_TEAMS = fs.readFileSync(path.join(__dirname, "../local/fake-teams.html"), "utf8");
const chrome = withChrome();
let context: BrowserContext;
let page: Page;
let tp: TeamsPage;

beforeEach(async () => {
  context = await chrome.browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("https://teams.cloud.microsoft/**", (r) => r.fulfill({ contentType: "text/html", body: FAKE_TEAMS }));
  page = await context.newPage();
  await page.goto("https://teams.cloud.microsoft/");
  const store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  store.saveChats(["Test User (You)", "Anna Rossi", "Luca Bianchi"].map((name) => ({ name, preview: "", time: "", unread: false, mention: false, muted: false, av: "" })));
  tp = new TeamsPage(page, store);
});

afterEach(async () => {
  await context?.close();
});

const mine = () => page.evaluate(() => [...document.querySelectorAll(".fui-ChatMyMessage")].map((m) => m.textContent));
const box = () => page.evaluate(() => (document.querySelector('[data-tid="ckeditor"]') as HTMLElement).innerText.trim());

describe("send on a page that behaves like Teams", () => {
  it("is sent once Teams shows the new message sent", async () => {
    expect(await sendText(tp, "Anna Rossi", "on my way")).toBe("sent");
    expect(await mine()).toEqual(["on my way"]);
  });

  it("is unconfirmed when the message went out but Teams never showed it sent", async () => {
    await page.evaluate(() => (window as unknown as { fakeTeams: { stall(on: boolean): void } }).fakeTeams.stall(true));
    expect(await sendText(tp, "Anna Rossi", "are you there?")).toBe("unconfirmed");
    // it is in the chat, still sending: sending it again would make two
    expect(await mine()).toEqual(["are you there?"]);
  }, 30_000);

  it("fails, and leaves alone a draft someone left in the compose box", async () => {
    expect(await tp.openChat("Anna Rossi")).toBe(true);
    await page.locator('[data-tid="ckeditor"]').click();
    await page.keyboard.type("my own draft");
    expect(await sendText(tp, "Anna Rossi", "hello")).toBe("failed");
    expect(await box()).toBe("my own draft");
    expect(await mine()).toEqual([]);
  });
});
