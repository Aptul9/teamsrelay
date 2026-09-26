// Page scripts on fixtures captured from Teams web (slot 2 of the local stack, 2026-09-26) with
// scripts/capture-fixture.ts: the structure is Teams', every name and text is invented.
import { describe, expect, it } from "vitest";
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

describe("action bar captured from Teams", () => {
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
