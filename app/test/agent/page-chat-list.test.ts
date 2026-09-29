// Chat list page scripts against a static copy of the Teams chat list.
import { describe, expect, it } from "vitest";
import { SEL, TEXTS } from "@/agent/teams/selectors";
import { clickChatRow, openChatTitle, readChatList, scrollChatList } from "@/agent/teams/scripts/chat-list";
import { picture, withChrome } from "./chrome";

const row = (id: string, text: string, extra = "") => `<div role="treeitem" aria-level="2" id="${id}" ${extra}>${text}</div>`;
const LIST = `
<div role="tree">
  <div role="treeitem" aria-level="1" aria-expanded="true">
    <div>Chats</div>
    <div role="group">
      ${row("menu-1", "Luca Bianchini 10:32 See you at noon")}
      ${row("menu-2", "Luca Bianchi 10:30 Ciao")}
      ${row("menu-3", "Available Anna Rossi 9:15 You: ok")}
      ${row("menu-4", "Project Alpha 9/24 Minutes attached")}
      ${row("menu-5", "Project Alpha Ops 9/23 Deploy done")}
    </div>
  </div>
</div>
<script>
  for (const r of document.querySelectorAll('[aria-level="2"]'))
    r.addEventListener('click', () => { document.body.dataset.clicked = r.id; });
</script>`;

const chrome = withChrome();

async function open(name: string) {
  await chrome.page.setContent(LIST);
  const ok = await chrome.page.evaluate(clickChatRow, { s: SEL, t: TEXTS, name });
  const clicked = await chrome.page.evaluate(() => document.body.dataset.clicked ?? null);
  return { ok, clicked };
}

describe("chat list page scripts", () => {
  it("reads the names the web app shows", async () => {
    await chrome.page.setContent(LIST);
    const chats = await chrome.page.evaluate(readChatList, { s: SEL, t: TEXTS });
    expect(chats.map((c) => c.name)).toEqual(["Luca Bianchini", "Luca Bianchi", "Anna Rossi", "Project Alpha", "Project Alpha Ops"]);
    expect(chats[2]).toEqual({ name: "Anna Rossi", preview: "You: ok", time: "9:15", unread: false, mention: false, muted: false, avsrc: "", presence: "" });
  });

  it("opens the exact chat when another name extends it", async () => {
    expect(await open("Luca Bianchi")).toEqual({ ok: true, clicked: "menu-2" });
    expect(await open("Luca Bianchini")).toEqual({ ok: true, clicked: "menu-1" });
    expect(await open("Project Alpha")).toEqual({ ok: true, clicked: "menu-4" });
  });

  it("ignores the presence text in front of the name", async () => {
    expect(await open("Anna Rossi")).toEqual({ ok: true, clicked: "menu-3" });
  });

  it("uses a prefix only when a single chat matches it", async () => {
    expect(await open("Anna")).toEqual({ ok: true, clicked: "menu-3" });
    expect(await open("Luca")).toEqual({ ok: false, clicked: null });
  });

  it("clicks nothing for an unknown chat, even if a preview contains the name", async () => {
    expect(await open("noon")).toEqual({ ok: false, clicked: null });
  });

  it("reads unread, mention, muted and picture, and skips Quick views", async () => {
    await chrome.page.setContent(`
      <div role="tree">
        <div role="treeitem" aria-level="1" aria-expanded="true"><div>Quick views</div><div role="group">${row("menu-q", "Mentions 10:00 x")}</div></div>
        <div role="treeitem" aria-level="1" aria-expanded="true">
          <div>Favorites</div>
          <div role="group">
            ${row("menu-a", `<img class="fui-Avatar__image" src="${picture(32)}">Anna Rossi 10:40 <span data-tid="unread"></span>are you there?`)}
            ${row("menu-b", "Release notes 9:00 build 1.4.2", 'data-item-type="muted-chat"')}
            ${row("menu-c", "Project Alpha 8:00 @you check", 'aria-label="Project Alpha, mentioned you"')}
          </div>
        </div>
      </div>`);
    const chats = await chrome.page.evaluate(readChatList, { s: SEL, t: TEXTS });
    expect(chats.map((c) => [c.name, c.unread, c.mention, c.muted, !!c.avsrc])).toEqual([
      ["Anna Rossi", true, false, false, true],
      ["Release notes", false, false, true, false],
      ["Project Alpha", false, true, false, false],
    ]);
  });

  it("opens a closed Chats section to read it", async () => {
    await chrome.page.setContent(`
      <div role="tree"><div role="treeitem" aria-level="1" aria-expanded="false"><div id="h">Chats</div></div></div>
      <script>
        document.getElementById('h').addEventListener('click', (e) => {
          const s = e.target.parentElement; s.setAttribute('aria-expanded', 'true');
          s.insertAdjacentHTML('beforeend', '<div role="group"><div role="treeitem" aria-level="2" id="menu-9">Marco Neri 7:00 hi</div></div>');
        });
      </script>`);
    expect((await chrome.page.evaluate(readChatList, { s: SEL, t: TEXTS })).map((c) => c.name)).toEqual(["Marco Neri"]);
    expect(await chrome.page.evaluate(() => document.querySelector('[aria-level="1"]')?.getAttribute("aria-expanded"))).toBe("true");
  });

  it("reads the title of the open chat and scrolls the list", async () => {
    await chrome.page.setContent(`
      <h2 data-tid="chat-title">Anna Rossi<br>Available</h2>
      <div style="height:200px; overflow-y:auto" id="list"><div role="tree">
        ${Array.from({ length: 30 }, (_, i) => `<div role="treeitem" aria-level="2" id="menu-${i}" style="height:40px">Chat ${i}</div>`).join("")}
      </div></div>`);
    expect(await chrome.page.evaluate(openChatTitle, SEL)).toBe("Anna Rossi");
    expect(await chrome.page.evaluate(scrollChatList, { s: SEL, to: "down" as const })).toBe(true);
    expect(await chrome.page.evaluate(() => document.getElementById("list")?.scrollTop)).toBe(160);
    expect(await chrome.page.evaluate(scrollChatList, { s: SEL, to: "top" as const })).toBe(true);
    expect(await chrome.page.evaluate(scrollChatList, { s: SEL, to: "top" as const })).toBe(false);
  });

  // header of a group chat without a name (structure taken from Teams web in September 2026): its first person,
  // then the others as "+N" on a line of their own; the list names the chat "Anna Rossi, +2"
  it("reads the title of a group chat without a name as the list names it", async () => {
    await chrome.page.setContent(`
      <h2 data-tid="chat-title"><div><ul role="list" data-tid="chat-topic-menu"><li role="listitem" data-tid="chat-topic-menu-list-item">
        <span data-tid="participant-8:orgid:00000000-0000-0000-0000-000000000001"><div data-tid="persona-presence-paceholder"></div><span>Anna Rossi</span></span>
      </li></ul><div><span> +2</span></div></div></h2>`);
    expect(await chrome.page.evaluate(openChatTitle, SEL)).toBe("Anna Rossi, +2");
  });
});
