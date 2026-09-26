// Activity feed page scripts against a static copy of the Teams Activity feed (structure taken from Teams web
// in September 2026, names and texts invented).
import { beforeAll, describe, expect, it } from "vitest";
import { SEL, TEXTS } from "@/agent/teams/selectors";
import { readActivityFeed, scrollActivityFeed, type FeedItem } from "@/agent/teams/scripts/activity";
import { withChrome } from "./chrome";

type Part = { title: string; bold?: boolean; unreadDot?: boolean; icon?: string; preview?: string; tm: string; location?: string; extra?: string };

function item(id: string, p: Part) {
  const f = (k: string) => `activity-feed-item-${k}-${id}`;
  return `
<div data-tid="activity-feed-list-item" role="option" aria-labelledby="${f("title")} ${f("message-preview")} ${f("location")} ${f("timestamp")}">
  ${p.unreadDot ? '<div class="feeditem_unread_indicator"></div>' : ""}
  <div data-tid="activity-feed-item-media-${id}">
    <span role="presentation"><img role="presentation"></span>
    ${p.icon ? `<span class="feeditem_type_icon_border"><img alt="${p.icon}"></span>` : '<span class="feeditem_type_icon_border"><svg><path></path></svg></span>'}
  </div>
  <span class="feeditem_content_text" data-tid="activity-feed-item-title" id="${f("title")}" style="font-weight:${p.bold ? 700 : 400}">${p.title}</span>
  ${p.preview ? `<span class="feeditem_preview_text" id="${f("message-preview")}">${p.preview}</span>` : ""}
  ${p.extra ?? ""}
  <span class="feeditem_timestamp_text" id="${f("timestamp")}">${p.tm}</span>
  ${p.location ? `<span class="feeditem_content_text" id="${f("location")}">${p.location}</span>` : ""}
  <button class="feeditem_menu_button"><span><svg><path></path></svg></span></button>
</div>`;
}

const FEED = [
  item("101", { title: "Anna Rossi reacted to your message", icon: "👍", preview: "see you later", tm: "9/24", location: "In chat with you" }),
  item("102", { title: "Mario Bianchi assigned you a task", preview: "Quarterly review", tm: "9/24", location: "Operations &gt; General" }),
  item("103", { title: "A team owner added you to Operations", bold: true, unreadDot: true, tm: "9/22" }),
  item("104", { title: "Luca Verdi updated", preview: "Weekly sync", tm: "9/17", location: "Sep 19, 9:30 AM - 10:00 AM" }),
  item("105", {
    title: '<div aria-label="External unfamiliar"><svg><path></path></svg></div><span></span>Missed call from Paolo Neri',
    tm: "8/29",
    extra: '<div class="feeditem_preview_text"><span data-tid="missed-call-feed-teams-call-string">Teams call</span><div><button>Call</button><button>Chat</button></div></div>',
  }),
  item("106", { title: "Sara Gialli mentioned Everyone", preview: "Release at 5 pm", tm: "9/14", location: "Project Alpha" }),
  item("107", { title: "Marco Blu posted in Support", preview: "New ticket", tm: "9/13", location: "Support", extra: "" }),
].join("");

const chrome = withChrome();
let feed: Record<string, FeedItem>;

beforeAll(async () => {
  await chrome.page.setContent(`<div role="listbox">${FEED}</div>`);
  const items = await chrome.page.evaluate(readActivityFeed, { s: SEL, t: TEXTS });
  feed = Object.fromEntries(items.map((a) => [a.id, a]));
});

describe("Activity feed page script", () => {
  it("reads a reaction in a 1:1 chat", () => {
    expect(feed["101"]).toMatchObject({ kind: "reaction", actor: "Anna Rossi", emoji: "👍", preview: "see you later", tm: "9/24", chat: "Anna Rossi", channel: false, unread: false });
  });

  it("keeps the action out of the name of the person", () => {
    expect(feed["102"].actor).toBe("Mario Bianchi");
    expect(feed["104"].actor).toBe("Luca Verdi");
    expect(feed["106"].actor).toBe("Sara Gialli");
    expect(feed["107"].actor).toBe("Marco Blu");
    expect(feed["103"].actor).toBe("A team owner");
  });

  it("marks a Team > Channel location as a channel", () => {
    expect(feed["102"]).toMatchObject({ kind: "task", chat: "Operations › General", channel: true });
    expect(feed["106"]).toMatchObject({ kind: "mention", chat: "Project Alpha", channel: false });
  });

  it("reads a missed call without the labels of its buttons", () => {
    expect(feed["105"]).toMatchObject({ kind: "call", actor: "Paolo Neri", preview: "Teams call", tm: "8/29", chat: "Paolo Neri", channel: false });
  });

  it("tells meetings, team invitations and unread items apart", () => {
    expect(feed["104"]).toMatchObject({ kind: "meeting", chat: "Sep 19, 9:30 AM - 10:00 AM" });
    expect(feed["103"]).toMatchObject({ kind: "team", chat: "", unread: true });
  });

  it("scrolls the virtualized feed", async () => {
    await chrome.page.setContent(`<div id="f" style="height:120px; overflow-y:auto">${FEED}${FEED}</div>`);
    expect(await chrome.page.evaluate(scrollActivityFeed, SEL)).toBe(true);
    expect(await chrome.page.evaluate(() => document.getElementById("f")?.scrollTop)).toBe(96);
  });
});
