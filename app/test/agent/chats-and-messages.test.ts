import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHAT_LIMIT, mergeChats, type ChatEntry } from "@/agent/logic/chats";
import { extraOf } from "@/agent/logic/messages";
import { SlotStore } from "@/agent/store/slot-store";
import { tempDir } from "../helpers";

const chat = (name: string, av = "", presence = ""): ChatEntry => ({ name, preview: "", time: "", unread: false, mention: false, muted: false, av, presence });

describe("chat list merge", () => {
  const stored = [chat("A", "a.png"), chat("B", "b.png"), chat("C", "c.png")];

  it("puts the visible chats first and keeps the others in their order", () => {
    expect(mergeChats([chat("C"), chat("D")], stored, false).map((c) => c.name)).toEqual(["C", "D", "A", "B"]);
  });

  it("keeps the known picture of a chat whose picture was not copied in this round", () => {
    const [c, d] = mergeChats([chat("C"), chat("D", "d.png")], stored, false);
    expect(c.av).toBe("c.png");
    expect(d.av).toBe("d.png");
  });

  it("keeps at most 40 chats", () => {
    const many = Array.from({ length: 45 }, (_, i) => chat(`old ${i}`));
    expect(mergeChats([chat("new")], many, false)).toHaveLength(CHAT_LIMIT);
  });

  it("replaces the list with a complete read", () => {
    expect(mergeChats([chat("B"), chat("D")], stored, true)).toEqual([chat("B", "b.png"), chat("D")]);
  });

  // a presence is as old as the read that saw it: rows out of this read show none rather than a stale one
  it("keeps the presence of the chats this read saw, and forgets it for the others", () => {
    const known = [chat("A", "", "away"), chat("B", "", "available")];
    expect(mergeChats([chat("C", "", "busy"), chat("A", "", "offline")], known, false).map((c) => [c.name, c.presence])).toEqual([
      ["C", "busy"],
      ["A", "offline"],
      ["B", ""],
    ]);
  });
});

describe("chat list saved by the agent", () => {
  it("keeps the presence of each chat", () => {
    const store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
    store.saveChats([chat("Anna Rossi", "", "away"), chat("Team, +2")]);
    expect(store.chats().map((c) => [c.name, c.presence])).toEqual([
      ["Anna Rossi", "away"],
      ["Team, +2", ""],
    ]);
  });
});

describe("message extra", () => {
  it("keeps the fields with a value, in a fixed order", () => {
    const extra = extraOf({ deleted: false, html: "<b>ok</b>", edited: true, images: [], quote: { author: "Anna", text: "hi" }, status: "" });
    expect(extra).toEqual({ quote: { author: "Anna", text: "hi" }, edited: true, html: "<b>ok</b>" });
    expect(Object.keys(extra ?? {})).toEqual(["quote", "edited", "html"]);
  });

  it("is null when no field has a value", () => {
    expect(extraOf({ reactions: [], files: [], mentionsMe: false, av: "" })).toBeNull();
    expect(extraOf({ readby: {} as never })).toBeNull();
  });
});
