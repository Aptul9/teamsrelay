// The send of the agent (teams/actions.ts) on a page that behaves like Teams (test/local/fake-teams.html): sent once
// Teams shows it, unconfirmed when it went out and Teams never shows it sent, failed when it never went out.
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "@/agent/commands";
import type { Agent } from "@/agent/context";
import { NewMessageDetector } from "@/agent/logic/new-messages";
import { Media } from "@/agent/media";
import type { Notifier } from "@/agent/push/notifier";
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
let store: SlotStore;

beforeEach(async () => {
  context = await chrome.browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("https://teams.cloud.microsoft/**", (r) => r.fulfill({ contentType: "text/html", body: FAKE_TEAMS }));
  page = await context.newPage();
  await page.goto("https://teams.cloud.microsoft/");
  store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  store.saveChats(["Test User (You)", "Anna Rossi", "Luca Bianchi"].map((name) => ({ name, preview: "", time: "", unread: false, mention: false, muted: false, av: "" })));
  tp = new TeamsPage(page, store);
});

afterEach(async () => {
  await context?.close();
});

const mine = () => page.evaluate(() => [...document.querySelectorAll(".fui-ChatMyMessage")].map((m) => m.textContent));
const fake = (fn: "stall" | "sendButton" | "coverSend", on: boolean) =>
  page.evaluate(([fn, on]) => (window as unknown as { fakeTeams: Record<string, (on: boolean) => void> }).fakeTeams[fn as string](on as boolean), [fn, on] as const);
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

  // a panel over the Send button catches the click: Playwright never clicks, nothing leaves the box
  it("fails, with the compose box emptied, when the click on Send never happened, so that the next send goes out", async () => {
    await fake("sendButton", true);
    expect(await tp.openChat("Anna Rossi")).toBe(true);
    await fake("coverSend", true);
    page.setDefaultTimeout(2000);
    expect(await sendText(tp, "Anna Rossi", "first try")).toBe("failed");
    expect(await box()).toBe("");
    expect(await mine()).toEqual([]);
    page.setDefaultTimeout(30_000);
    await fake("coverSend", false);
    expect(await sendText(tp, "Anna Rossi", "second try")).toBe("sent");
    expect(await mine()).toEqual(["second try"]);
  }, 30_000);

  // the web app shows its "sending" bubble until the message is in the saved chat, and "Not sent, Try again" after
  // 14 s: the chat is saved as soon as the message went, not after Teams confirmed it
  it("saves the chat as soon as the message went, before Teams confirms it", async () => {
    await fake("stall", true);
    const a = {
      config: { uploadsDir: tempDir(), activity: true, readBy: true, alerts: { signInAfter: 60, browserAfter: 300, signIn: "", browserDown: "" } },
      store,
      notifier: { alert: async () => 0, message: async () => undefined, push: async () => 0, deviceCount: () => 0 } as unknown as Notifier,
      media: new Media(tempDir(), tempDir()),
      detector: new NewMessageDetector(),
      tp,
      health: null,
    } satisfies Agent;
    const outcome = runCommand(a, { id: 1, type: "send", arg1: "Anna Rossi", arg2: "slow to confirm" });
    await expect.poll(() => store.messages("Anna Rossi").map((m) => [m.text, m.status]), { timeout: 8000 }).toContainEqual(["slow to confirm", "Sending..."]);
    expect(await outcome).toBe("unconfirmed");
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
