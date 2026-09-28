// An action Teams did not take, because something stays open over the chat or the list has no such chat: the web app
// only sees "failed", so the log says which.
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlotStore } from "@/agent/store/slot-store";
import { TeamsPage } from "@/agent/teams/page";
import { openOverlays } from "@/agent/teams/scripts/message-actions";
import { SEL } from "@/agent/teams/selectors";
import { tempDir } from "../helpers";
import { withChrome } from "./chrome";

const PAGE = `<!doctype html>
<h2 data-tid="chat-title">Anna Rossi</h2>
<div role="tree">
  <div role="treeitem" aria-level="1" aria-expanded="true"><div>Chats</div>
    <div role="group"><div role="treeitem" aria-level="2" id="menu-chat-0">Anna Rossi</div></div>
  </div>
</div>`;

// a callout of Teams that Escape leaves open, as its focus is elsewhere
const CALLOUT = `<div role="dialog" aria-label="Meet Copilot" data-tid="teaching-popover"
  style="position: fixed; top: 40px; left: 0; width: 200px; height: 80px">Try it</div>`;
const CLOSES_ON_ESCAPE = `<script>
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelector('[role="dialog"]')?.remove(); });
</script>`;

const chrome = withChrome();
let context: BrowserContext;
let page: Page;
let tp: TeamsPage;
let lines: string[];

async function open(html: string) {
  context = await chrome.browser.newContext({ viewport: { width: 1024, height: 618 } });
  page = await context.newPage();
  await page.setContent(html);
  const store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  store.saveChats([{ name: "Anna Rossi", preview: "", time: "", unread: false, mention: false, muted: false, av: "" }]);
  tp = new TeamsPage(page, store);
  lines = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await context?.close();
});

describe("the log says why an action on Teams was not taken", () => {
  it("names the overlay still open over the chat after Escape", async () => {
    await open(PAGE + CALLOUT);
    expect(await tp.clearOverlays()).toBe(false);
    expect(lines).toEqual([expect.stringMatching(/^page: overlay still open after Escape overlays="dialog Meet Copilot teaching-popover"$/)]);
  });

  it("says nothing of an overlay Escape closed", async () => {
    await open(PAGE + CALLOUT + CLOSES_ON_ESCAPE);
    expect(await tp.clearOverlays()).toBe(true);
    expect(lines).toEqual([]);
  });

  // Teams of the MSC Cruises account (2026-09-28) keeps an empty Profile Card dialog of no size in the page: counted as
  // open, it failed every send of that account
  it("takes an empty dialog of no size for nothing open", async () => {
    await open(`${PAGE}<div role="dialog" aria-label="Profile Card" style="position: absolute; top: 0; left: 0; width: 0; height: 0"></div>`);
    expect(await tp.clearOverlays()).toBe(true);
    expect(await page.evaluate(openOverlays, SEL)).toBe(0);
    expect(lines).toEqual([]);
  });

  it("takes as closed what the third Escape closed", async () => {
    const stacked = [1, 2, 3].map((i) => CALLOUT.replace("Meet Copilot", `Callout ${i}`)).join("");
    const onePerEscape = `<script>
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelector('[role="dialog"]')?.remove(); });
    </script>`;
    await open(PAGE + stacked + onePerEscape);
    expect(await tp.clearOverlays()).toBe(true);
    expect(lines).toEqual([]);
  });

  it("names a chat the list does not have, once for the sweeps of 30 s", async () => {
    await open(PAGE);
    expect(await tp.openChat("Nobody Here")).toBe(false);
    expect(await tp.openChat("Nobody Here")).toBe(false);
    expect(lines).toEqual([expect.stringMatching(/^open: chat not in the list chat="Nobody Here"$/)]);
  }, 30_000);
});
