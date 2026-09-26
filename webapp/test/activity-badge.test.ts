import { describe, expect, it } from "vitest";
import { markActivitySeen, parseSeen, unseenActivity, type ActivityItem } from "@/lib/client";

const item = (id: string, unread = 1): ActivityItem => ({
  id,
  unread,
  kind: "reaction",
  actor: "",
  title: "",
  emoji: "",
  preview: "",
  tm: "",
  chat: "",
  channel: 0,
  av: "",
});

describe("unseenActivity", () => {
  it("counts nothing before the feed was first looked at", () => {
    expect(unseenActivity([item("a"), item("b")], null)).toBe(0);
  });

  it("counts unread items that arrived after the last look", () => {
    const seen = markActivitySeen(null, [item("a"), item("b", 0)]);
    expect(unseenActivity([item("c"), item("a"), item("b", 0)], seen)).toBe(1);
  });

  it("never counts read items", () => {
    expect(unseenActivity([item("c", 0), item("d", 0)], [])).toBe(0);
  });

  it("stops counting an item once the feed is looked at", () => {
    const items = [item("c"), item("a")];
    expect(unseenActivity(items, markActivitySeen(["a"], items))).toBe(0);
  });
});

describe("markActivitySeen", () => {
  it("keeps the ids that left the feed, newest first, up to 200", () => {
    const seen = markActivitySeen(["x", "y"], [item("a"), item("x")]);
    expect(seen).toEqual(["a", "x", "y"]);
    const many = Array.from({ length: 250 }, (_, i) => `old${i}`);
    expect(markActivitySeen(many, [item("a")])).toHaveLength(200);
  });
});

describe("parseSeen", () => {
  it("reads what markActivitySeen stored, nothing else", () => {
    expect(parseSeen(JSON.stringify(["a", "b"]))).toEqual(["a", "b"]);
    expect(parseSeen(null)).toBeNull();
    expect(parseSeen("{")).toBeNull();
    expect(parseSeen('{"a":1}')).toBeNull();
  });
});
