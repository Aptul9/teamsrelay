import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Calls } from "@/components/Calls";
import type { ActivityItem } from "@/lib/client";

// A missed call as the Teams Activity feed shows it: never bold, new or not
const missed = (id: string, actor: string): ActivityItem => ({
  id,
  kind: "call",
  actor,
  title: `Missed call from ${actor}`,
  emoji: "",
  preview: "Teams call",
  tm: "3:54 PM",
  chat: actor,
  channel: 0,
  unread: 0,
  av: "",
});

const render = (seen: string[] | null) =>
  renderToStaticMarkup(
    createElement(Calls, {
      acc: 2,
      ringing: undefined,
      missed: [missed("c2", "Anna Rossi"), missed("c1", "Luca Bianchi")],
      log: [],
      seen,
      chatOf: () => null,
      onOpenChat: () => undefined,
    }),
  );

describe("Calls list", () => {
  it("puts a red dot on each missed call this device has not shown yet, though Teams shows it as read", () => {
    expect(render(["c1"]).match(/aria-label="New"/g)).toHaveLength(1);
    expect(render(["c2", "c1"])).not.toContain('aria-label="New"');
    expect(render(null)).not.toContain('aria-label="New"');
  });
});
