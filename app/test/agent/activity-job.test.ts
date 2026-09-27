// The Activity job (jobs/activity.ts) on a page with the Teams rail. The presence keeper leaves the mouse on the
// app launcher, whose tooltip then covers the Activity button; like the Fluent tooltip of Teams it closes a moment
// after the mouse leaves the launcher, and stays open while the mouse is on it.
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activity } from "@/agent/commands/activity";
import type { Agent } from "@/agent/context";
import { readActivity } from "@/agent/jobs/activity";
import { keepActive } from "@/agent/jobs/page-setup";
import { SlotStore } from "@/agent/store/slot-store";
import { TeamsPage } from "@/agent/teams/page";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";
import { withChrome } from "./chrome";

const FEED_ITEM = `
<div data-tid="activity-feed-list-item" role="option" aria-labelledby="activity-feed-item-title-101 activity-feed-item-message-preview-101 activity-feed-item-location-101 activity-feed-item-timestamp-101">
  <div data-tid="activity-feed-item-media-101"><span role="presentation"><img role="presentation"></span><span class="feeditem_type_icon_border"><img alt="👍"></span></div>
  <span class="feeditem_content_text" data-tid="activity-feed-item-title" id="activity-feed-item-title-101" style="font-weight:400">Anna Rossi reacted to your message</span>
  <span class="feeditem_preview_text" id="activity-feed-item-message-preview-101">see you later</span>
  <span class="feeditem_timestamp_text" id="activity-feed-item-timestamp-101">9/24</span>
  <span class="feeditem_content_text" id="activity-feed-item-location-101">In chat with you</span>
</div>`;

const RAIL = `<!doctype html>
<style>
  body { margin: 0 }
  #waffle { position: absolute; left: 0; top: 0; width: 48px; height: 48px }
  #tip { position: absolute; left: 0; top: 51px; width: 167px; height: 28px; background: #333; color: #fff; display: none; z-index: 10 }
  .rail { position: absolute; left: 0; width: 68px; height: 44px }
  #main { position: absolute; left: 80px; top: 48px; width: 600px }
</style>
<button id="waffle" data-tid="waffle-open-button" aria-label="Open office app launcher"></button>
<div id="tip" role="tooltip">Open office app launcher</div>
<button class="rail" style="top:48px" aria-label="Activity (Ctrl+Shift+1)"></button>
<button class="rail" style="top:92px" aria-label="Chat (Ctrl+Shift+2)"></button>
<div id="main"></div>
<script>
  const tip = document.getElementById("tip");
  let hide = 0;
  const show = () => { clearTimeout(hide); tip.style.display = "block"; };
  const later = () => { hide = setTimeout(() => (tip.style.display = "none"), 250); };
  document.getElementById("waffle").addEventListener("mouseenter", show);
  document.getElementById("waffle").addEventListener("mouseleave", later);
  tip.addEventListener("mouseenter", show);
  tip.addEventListener("mouseleave", later);
  const main = document.getElementById("main");
  const [activity, chat] = document.querySelectorAll(".rail");
  activity.addEventListener("click", () => (main.innerHTML = ${JSON.stringify(FEED_ITEM)}));
  chat.addEventListener("click", () => (main.innerHTML = '<div role="tree"><div role="treeitem" aria-level="2">Anna Rossi</div></div>'));
  chat.click();
</script>`;

// Teams right after a start (slot 2, 2026-09-27): the chat list is there, the rail shows a few seconds later, then
// the loading bar of Teams covers it a few seconds more
const STARTING = `<!doctype html>
<style>
  body { margin: 0 }
  .rail { position: absolute; left: 0; width: 68px; height: 44px }
  #main { position: absolute; left: 80px; top: 48px; width: 600px }
  #loading { position: fixed; inset: 0; z-index: 10 }
</style>
<div id="loading" role="progressbar"></div>
<div id="main"><div role="tree"><div role="treeitem" aria-level="2">Anna Rossi</div></div></div>
<script>
{
  const main = document.getElementById("main");
  const views = [
    ["Activity (Ctrl+Shift+1)", 48, ${JSON.stringify(FEED_ITEM)}],
    ["Chat (Ctrl+Shift+2)", 92, '<div role="tree"><div role="treeitem" aria-level="2">Anna Rossi</div></div>'],
  ];
  setTimeout(() => {
    for (const [label, top, html] of views) {
      const b = document.createElement("button");
      b.className = "rail";
      b.style.top = top + "px";
      b.setAttribute("aria-label", label);
      b.addEventListener("click", () => (main.innerHTML = html));
      document.body.appendChild(b);
    }
  }, 2000);
  setTimeout(() => document.getElementById("loading").remove(), 6000);
}
</script>`;

const chrome = withChrome();
let context: BrowserContext;
let page: Page;
let store: SlotStore;
let agent: Agent;

beforeEach(async () => {
  context = await chrome.browser.newContext({ viewport: { width: 1024, height: 618 } });
  page = await context.newPage();
  await page.setContent(RAIL);
  store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  const media = { avatars: async (_: Page, items: { avsrc: string }[]) => items.map((i) => ({ ...i, av: "" })) };
  agent = { tp: new TeamsPage(page, store), store, media } as unknown as Agent;
});

afterEach(async () => {
  await context?.close();
});

describe("Activity feed read", () => {
  it("reads the feed and goes back to the chat view", async () => {
    expect(await readActivity(agent)).toBe(1);
    expect(Number(store.getState(STATE.activityTs))).toBeGreaterThan(0);
    expect(await page.locator('[role="treeitem"][aria-level="2"]').count()).toBe(1);
  });

  it("reads the feed while the tooltip of the app launcher covers the Activity button", async () => {
    await keepActive(agent);
    expect(await page.locator("#tip").isVisible()).toBe(true);
    expect(await readActivity(agent)).toBe(1);
    expect(await page.locator('[role="treeitem"][aria-level="2"]').count()).toBe(1);
  }, 30_000);

  it("reads the feed on a refresh asked right after a start, once the side bar shows and the loading bar is gone", async () => {
    await page.setContent(STARTING);
    expect(await activity(agent, { id: 1, type: "activity", arg1: "", arg2: "" })).toBe("done");
    expect(Number(store.getState(STATE.activityTs))).toBeGreaterThan(0);
    expect(await page.locator('[role="treeitem"][aria-level="2"]').count()).toBe(1);
  }, 30_000);
});
