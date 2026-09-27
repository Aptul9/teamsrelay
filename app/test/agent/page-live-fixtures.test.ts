// Page scripts on fixtures captured from Teams web (slot 2 of the local stack, 2026-09-26) with
// scripts/capture-fixture.ts: the structure is Teams', every name and text is invented.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIONS, BAR_REACTIONS, SEL, TEXTS } from "@/agent/teams/selectors";
import { readActivityFeed } from "@/agent/teams/scripts/activity";
import { clickChatRow, openChatTitle, readChatList } from "@/agent/teams/scripts/chat-list";
import { readMessages } from "@/agent/teams/scripts/conversation";
import { barButtonPoint } from "@/agent/teams/scripts/message-actions";
import { ACTIVITY_KINDS } from "@/shared/slot-db/rows";
import { fixture, withChrome } from "./chrome";

const chrome = withChrome();

describe("chat list captured from Teams", () => {
  it("reads 40 chats, the self chat first", async () => {
    await chrome.page.setContent(fixture("chat-list.html"));
    const rows = await chrome.page.evaluate(readChatList, { s: SEL, t: TEXTS });
    expect(rows).toHaveLength(40);
    expect(new Set(rows.map((r) => r.name)).size).toBe(40);
    expect(rows[0]).toMatchObject({ name: expect.stringMatching(/\(You\)$/), time: "", preview: "" });
    for (const r of rows.slice(1)) expect(r.time, r.name).toMatch(/^\d{1,2}\/\d{1,2}$/);
    expect(rows.some((r) => r.preview.startsWith("You: "))).toBe(true);
    expect(rows.some((r) => /, \+2$/.test(r.name))).toBe(true);
  });

  it("finds the muted chats and the pictures Teams marks", async () => {
    await chrome.page.setContent(fixture("chat-list.html"));
    const rows = await chrome.page.evaluate(readChatList, { s: SEL, t: TEXTS });
    // rows of the Chats and Favorites sections marked muted by Teams, counted apart from the script
    const marked = await chrome.page.evaluate(
      ({ s, t }) =>
        [...document.querySelectorAll(s.chatRow)].filter((e) => {
          const sec = e.parentElement?.closest(s.section);
          const head = ((sec?.querySelector(s.sectionHeader) as HTMLElement | null)?.innerText ?? "").trim();
          return t.listSection.test(head) && (e.getAttribute("data-item-type") === s.mutedItemType || !!e.querySelector(s.mutedIcon));
        }).length,
      { s: SEL, t: TEXTS },
    );
    expect(rows.filter((r) => r.muted).length).toBe(marked);
    expect(marked).toBeGreaterThan(0);
    expect(rows.filter((r) => r.avsrc).length).toBeGreaterThan(10);
  });

  it("clicks the row of every name it reads", async () => {
    await chrome.page.setContent(fixture("chat-list.html"));
    const rows = await chrome.page.evaluate(readChatList, { s: SEL, t: TEXTS });
    for (const { name } of rows.slice(0, 12)) {
      await chrome.page.evaluate(() => {
        delete document.body.dataset.clicked;
        for (const r of document.querySelectorAll('[role="treeitem"][aria-level="2"]')) r.addEventListener("click", () => (document.body.dataset.clicked = r.id), { once: true });
      });
      expect(await chrome.page.evaluate(clickChatRow, { s: SEL, t: TEXTS, name }), name).toBe(true);
      const text = await chrome.page.evaluate(() => {
        const id = document.body.dataset.clicked ?? "";
        return id ? ((document.getElementById(id) as HTMLElement).innerText || "").replace(/\s+/g, " ") : "";
      });
      expect(text, name).toContain(name);
    }
  });
});

describe("conversation captured from Teams", () => {
  it("reads the title and the messages with their authors", async () => {
    await chrome.page.setContent(fixture("conversation.html"));
    expect(await chrome.page.evaluate(openChatTitle, SEL)).not.toBe("");
    const msgs = await chrome.page.evaluate(readMessages, { s: SEL, t: TEXTS });
    expect(msgs).toHaveLength(12);
    expect(new Set(msgs.map((m) => m.mid)).size).toBe(12);
    for (const m of msgs) {
      expect(m.mid).toMatch(/^\d{13}$/);
      expect(m.text, m.mid).not.toBe("");
      expect(m.author, m.mid).not.toBe("");
      expect(m.html).not.toMatch(/<script|on\w+=/i);
    }
    expect(msgs.filter((m) => m.mine).length).toBe(4);
    expect(msgs.filter((m) => !m.mine).length).toBe(8);
  });

  it("reads the status of your last message and the reactions", async () => {
    await chrome.page.setContent(fixture("conversation.html"));
    const msgs = await chrome.page.evaluate(readMessages, { s: SEL, t: TEXTS });
    expect(msgs.at(-1)).toMatchObject({ mine: true, status: "Scheduled" });
    expect(msgs.filter((m) => m.reactions.length).map((m) => m.reacts)).toEqual(["👍"]);
    expect(msgs.filter((m) => m.avsrc).length).toBeGreaterThan(0);
  });
});

describe("image message captured from Teams", () => {
  // Teams draws this 1x1 GIF until it has loaded the image, then a blob: address (AMS image component)
  const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
  const ORIGINAL = "https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/fixture-1/views/imgo_webp";

  // images of the messages, after `prepare` changed the page
  async function images(prepare?: (arg: { placeholder: string; attr: string }) => void) {
    await chrome.page.setContent(fixture("conversation-image.html"));
    if (prepare) await chrome.page.evaluate(prepare, { placeholder: PLACEHOLDER, attr: SEL.lazyImageSource });
    await chrome.page.waitForFunction(() => [...document.images].every((i) => i.complete));
    const msgs = await chrome.page.evaluate(readMessages, { s: SEL, t: TEXTS });
    return msgs.filter((m) => m.images.length).map((m) => m.images);
  }

  it("reads the loaded image with its size", async () => {
    expect(await images()).toEqual([[{ src: expect.stringContaining("data:image/svg+xml"), w: 554, h: 554, loaded: true }]]);
  });

  it("takes the address of an image still showing the placeholder", async () => {
    const found = await images(({ placeholder, attr }) => {
      for (const i of document.querySelectorAll(`img[${attr}]`)) i.setAttribute("src", placeholder);
    });
    expect(found).toEqual([[{ src: ORIGINAL, w: 0, h: 0, loaded: false }]]);
  });

  it("leaves out an image still showing the placeholder when it has no address", async () => {
    const found = await images(({ placeholder, attr }) => {
      for (const i of document.querySelectorAll(`img[${attr}]`)) {
        i.setAttribute("src", placeholder);
        i.removeAttribute(attr);
      }
    });
    expect(found).toEqual([]);
  });
});

describe("action bar captured from Teams", () => {
  // the bar of your message was captured in a window 1534 px wide, right of the 1280 px of the test page: a point
  // outside the window is one nothing can click
  beforeEach(() => chrome.page.setViewportSize({ width: 1600, height: 900 }));
  afterEach(() => chrome.page.setViewportSize({ width: 1280, height: 900 }));

  async function bar(file: string) {
    await chrome.page.setContent(fixture(file));
    const mid = await chrome.page.evaluate(() => document.querySelector('[data-fixture="hovered"] [data-tid="chat-pane-message"]')?.getAttribute("data-mid") ?? "");
    return (tid: string) => chrome.page.evaluate(barButtonPoint, { s: SEL, mid, tid });
  }

  it("offers edit and more options on your message", async () => {
    const point = await bar("toolbar-mine.html");
    expect(await point(ACTIONS.edit)).not.toBeNull();
    expect(await point(ACTIONS.more)).not.toBeNull();
    expect(await point(ACTIONS.quotedReply)).toBeNull();
    expect(await point(BAR_REACTIONS.like as string)).toBeNull();
  });

  it("offers reactions, reply and more options on a message of others", async () => {
    const point = await bar("toolbar-other.html");
    for (const tid of [...Object.values(BAR_REACTIONS), ACTIONS.picker, ACTIONS.quotedReply, ACTIONS.more]) expect(await point(tid as string), tid).not.toBeNull();
    expect(await point(ACTIONS.edit)).toBeNull();
  });
});

describe("Activity feed captured from Teams", () => {
  it("reads reactions, a channel task and a meeting", async () => {
    await chrome.page.setContent(fixture("activity.html"));
    const feed = await chrome.page.evaluate(readActivityFeed, { s: SEL, t: TEXTS });
    expect(feed).toHaveLength(11);
    expect(new Set(feed.map((a) => a.id)).size).toBe(11);
    for (const a of feed) {
      expect(ACTIVITY_KINDS).toContain(a.kind);
      expect(a.actor).not.toBe("");
      expect(a.tm).toMatch(TEXTS.feedTime);
    }
    expect(feed.map((a) => a.kind).sort()).toEqual([...Array(9).fill("reaction"), "meeting", "task"].sort());
    const reactions = feed.filter((a) => a.kind === "reaction");
    for (const a of reactions) expect([a.chat, a.channel, a.emoji !== ""]).toEqual([a.actor, false, true]);
    expect(feed.find((a) => a.kind === "task")).toMatchObject({ channel: true, chat: expect.stringMatching(/ › General$/) });
    expect(feed.find((a) => a.kind === "meeting")?.chat).toMatch(TEXTS.meetingTime);
  });
});
