// Opening a chat (TeamsPage.openChat) on a list that is virtualized as in Teams: only the rows in view are in the
// page. A row click shows the chat in the header.
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { SlotStore } from "@/agent/store/slot-store";
import { TeamsPage } from "@/agent/teams/page";
import { tempDir } from "../helpers";
import { withChrome } from "./chrome";

const page_ = (names: string[]) => `<!doctype html>
<style>body { margin: 0 } #list { height: 300px; overflow-y: auto } #rows { position: relative; height: ${names.length * 40}px }
  #rows > div { position: absolute; left: 0; height: 40px }</style>
<h2 data-tid="chat-title"></h2>
<div id="list" role="tree">
  <div role="treeitem" aria-level="1" aria-expanded="true"><div>Chats</div><div role="group" id="rows"></div></div>
</div>
<div id="pane"></div>
<script>
  const names = ${JSON.stringify(names)};
  const list = document.getElementById("list");
  const rows = document.getElementById("rows");
  window.clicked = [];
  function render() {
    const from = Math.max(0, Math.floor(list.scrollTop / 40) - 1);
    const to = Math.min(names.length, Math.ceil((list.scrollTop + 300) / 40) + 1);
    rows.replaceChildren(...names.slice(from, to).map((name, k) => {
      const i = from + k;
      const row = document.createElement("div");
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", "2");
      row.id = "menu-chat-" + i;
      row.style.top = i * 40 + "px";
      row.textContent = name;
      row.addEventListener("click", () => {
        window.clicked.push(name);
        document.querySelector('[data-tid="chat-title"]').textContent = name;
        document.getElementById("pane").innerHTML = '<div data-tid="chat-pane-message" data-mid="1">hello</div>';
      });
      return row;
    }));
  }
  list.addEventListener("scroll", render);
  render();
</script>`;

const chrome = withChrome();
let context: BrowserContext;
let page: Page;
let tp: TeamsPage;

async function open(names: string[]) {
  context = await chrome.browser.newContext({ viewport: { width: 1024, height: 618 } });
  page = await context.newPage();
  await page.setContent(page_(names));
  const store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  store.saveChats(names.map((name) => ({ name, preview: "", time: "", unread: false, mention: false, muted: false, av: "" })));
  tp = new TeamsPage(page, store);
}

const title = () => page.evaluate(() => document.querySelector('[data-tid="chat-title"]')?.textContent);
const scrollTop = () => page.evaluate(() => document.getElementById("list")?.scrollTop);
const clicked = () => page.evaluate(() => (window as unknown as { clicked: string[] }).clicked);

afterEach(async () => {
  await context?.close();
});

describe("open a chat of a virtualized list", () => {
  const chats = Array.from({ length: 40 }, (_, i) => `Chat ${String(i).padStart(2, "0")}`);

  it("opens a chat in view", async () => {
    await open(chats);
    expect(await tp.openChat("Chat 02")).toBe(true);
    expect(await title()).toBe("Chat 02");
  });

  it("opens a chat further down, only in the page once scrolled to, and leaves the list at the top", async () => {
    await open(chats);
    expect(await tp.openChat("Chat 34")).toBe(true);
    expect(await title()).toBe("Chat 34");
    expect(await scrollTop()).toBe(0);
  }, 30_000);

  // the prefix fallback would click the group chat in view: it opens, and Teams marks it read
  it("opens the chat of that exact name further down rather than one in view that starts the same", async () => {
    await open(["Anna Rossi, +2", ...chats.slice(0, 20), "Anna Rossi"]);
    expect(await tp.openChat("Anna Rossi")).toBe(true);
    expect(await clicked()).toEqual(["Anna Rossi"]);
  }, 30_000);
});
