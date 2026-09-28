import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "@/components/Conversation";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Message } from "@/lib/client";
import { dayLabel, fullTime, placeMessages, sentAt, timeLabel } from "@/lib/message-times";

// Local times, as the device shows them: a Teams message id is the epoch ms it was sent
const at = (d: number, h: number, m: number) => new Date(2026, 8, d, h, m).getTime();
const msg = (t: number, author: string, mine = 0): Message => ({ mid: String(t), author, text: `at ${t}`, mine, reacts: "" });

describe("sentAt", () => {
  it("reads the time a message was sent from its Teams id", () => {
    expect(sentAt("1790596581894")).toBe(1790596581894);
  });

  it("gives no time for an id that is not one", () => {
    expect(sentAt("x3")).toBeNull();
    expect(sentAt("")).toBeNull();
    expect(sentAt("179059658189")).toBeNull();
  });
});

describe("placeMessages", () => {
  it("keeps consecutive messages of one person within minutes in one group", () => {
    expect(placeMessages([msg(at(28, 9, 36), "Simonetta Viola"), msg(at(28, 9, 40), "Simonetta Viola")]).map((p) => p.first)).toEqual([true, false]);
  });

  it("starts a new group after a pause of more than five minutes, author and time shown again", () => {
    expect(placeMessages([msg(at(28, 9, 36), "Simonetta Viola"), msg(at(28, 10, 1), "Simonetta Viola")]).map((p) => p.first)).toEqual([true, true]);
  });

  it("starts a new group when the other side answers, as before", () => {
    const placed = placeMessages([msg(at(28, 13, 54), "Simonetta Viola"), msg(at(28, 13, 55), "", 1), msg(at(28, 13, 56), "", 1)]);
    expect(placed.map((p) => p.first)).toEqual([true, true, false]);
  });

  it("marks the first message of each day, which also starts a group", () => {
    const placed = placeMessages([msg(at(27, 18, 10), "Simonetta Viola"), msg(at(27, 18, 12), "Simonetta Viola"), msg(at(28, 9, 0), "Simonetta Viola")]);
    expect(placed).toEqual([
      { first: true, day: true },
      { first: false, day: false },
      { first: true, day: true },
    ]);
  });

  it("starts a group at midnight even within five minutes: the divider of the day stands between", () => {
    const placed = placeMessages([msg(at(27, 23, 58), "Simonetta Viola"), msg(at(28, 0, 1), "Simonetta Viola")]);
    expect(placed).toEqual([
      { first: true, day: true },
      { first: true, day: true },
    ]);
  });

  it("breaks nothing on time for messages without one", () => {
    const placed = placeMessages([
      { mid: "x1", author: "Anna Rossi", mine: 0 },
      { mid: "x2", author: "Anna Rossi", mine: 0 },
    ]);
    expect(placed).toEqual([
      { first: true, day: false },
      { first: false, day: false },
    ]);
  });
});

describe("dayLabel", () => {
  const now = at(28, 14, 0);

  it("names today and yesterday", () => {
    expect(dayLabel(at(28, 9, 36), now)).toBe("Today");
    expect(dayLabel(at(27, 23, 59), now)).toBe("Yesterday");
  });

  it("gives the date of an older day, with the year only when it is another one", () => {
    const d = new Date(at(24, 10, 0));
    expect(dayLabel(d.getTime(), now)).toBe(d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }));
    const old = new Date(2025, 11, 31, 10, 0);
    expect(dayLabel(old.getTime(), now)).toBe(old.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }));
  });
});

describe("times in the open chat", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 28, 14, 0));
  });
  afterEach(() => vi.useRealTimers());

  // inside the provider of the tooltips, as in the app
  const render = (rows: Message[]) =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(Conversation, { acc: 1, chat: "Simonetta Viola", rows, stopped: false, others: 0, onBack: () => undefined, onOpenDesktop: () => undefined }),
      ),
    );
  const stamp = (t: number) => new RegExp(`<time[^>]*datetime="${new Date(t).toISOString()}"[^>]*>${timeLabel(t)}</time>`, "i");

  // the chat of the report: two requests hours apart that looked like one, then the answer
  const rows = [
    msg(at(27, 18, 10), "Simonetta Viola"),
    msg(at(28, 9, 36), "Simonetta Viola"),
    msg(at(28, 10, 1), "Simonetta Viola"),
    msg(at(28, 10, 4), "Simonetta Viola"),
    msg(at(28, 13, 56), "", 1),
  ];

  it("shows the time above each group of messages, yours included", () => {
    const html = render(rows);
    for (const t of [at(27, 18, 10), at(28, 9, 36), at(28, 10, 1), at(28, 13, 56)]) expect(html).toMatch(stamp(t));
    expect(html).not.toMatch(stamp(at(28, 10, 4)));
  });

  it("puts a divider above the first message of each day", () => {
    const html = render(rows);
    const yesterday = html.indexOf(">Yesterday<");
    const today = html.indexOf(">Today<");
    expect(yesterday).toBeGreaterThan(-1);
    expect(today).toBeGreaterThan(yesterday);
    expect(html.indexOf(`data-mid="${at(28, 9, 36)}"`)).toBeGreaterThan(today);
  });

  it("keeps the divider of a day whose first message shows nothing", () => {
    const html = render([msg(at(27, 18, 10), "Simonetta Viola"), { ...msg(at(28, 9, 36), "Simonetta Viola"), text: " " }, msg(at(28, 9, 38), "Simonetta Viola")]);
    expect(html).toContain(">Today<");
    expect(html).not.toContain(`data-mid="${at(28, 9, 36)}"`);
  });

  it("gives every message its full date and time on hover", () => {
    expect(render(rows)).toContain(`title="${fullTime(at(28, 10, 4))}"`);
  });
});
