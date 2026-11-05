import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/agent/context";
import { readActivity } from "@/agent/jobs/activity";
import { SlotStore } from "@/agent/store/slot-store";
import { tempDir } from "../helpers";

const note = (id: number, type: string, who: string, extra: Record<string, unknown> = {}, read = true) => ({
  properties: {
    isread: read ? "true" : "false",
    activity: JSON.stringify({ activityId: id, activityType: type, sourceUserImDisplayName: who, activityTimestamp: new Date(Date.now() - id * 1000).toISOString(), ...extra }),
  },
});

function agent(token: string) {
  const store = SlotStore.open(path.join(tempDir(), "messages.db"));
  const page = {
    context: () => ({ cookies: async () => [{ name: "authtoken_asm", value: `Bearer%20${token}`, domain: ".asyncgw.teams.microsoft.com", path: "/" }] }),
    evaluate: vi.fn(async () => []),
    locator: () => {
      throw new Error("no page feed expected");
    },
  };
  const tp = { page, clearOverlays: vi.fn(async () => undefined), clickRail: vi.fn(async () => undefined), openChat: vi.fn(async () => true) };
  const a = { store, tp, media: { avatars: async () => [] } } as unknown as Agent;
  return { a, store, tp };
}

afterEach(() => vi.unstubAllGlobals());

describe("Activity feed of a browser account", () => {
  it("reads it through chatsvc, without taking Teams to the Activity view", async () => {
    const { a, store, tp } = agent("feed-token-1");
    store.saveChats([{ name: "Anna Rossi", preview: "", time: "", unread: false, mention: false, muted: false, av: "anna.png", presence: "", kind: "one" }]);
    store.saveActivity([{ id: "2", kind: "reaction", actor: "Marco Bianchi", title: "", emoji: "", preview: "", tm: "", chat: "", channel: false, unread: false, av: "marco.png" }]);
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer feed-token-1");
      return new Response(
        JSON.stringify({
          messages: [
            note(1, "mentionInChat", "Anna Rossi", { sourceThreadId: "19:ops@thread.v2", sourceThreadTopic: "Ops", messagePreview: "look" }, false),
            note(2, "reactionInChat", "Marco Bianchi", { activitySubtype: "like" }),
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    expect(await readActivity(a)).toBe(2);
    expect(String(fetch.mock.calls[0][0])).toContain("/conversations/48%3Anotifications/messages");
    expect(tp.clickRail).not.toHaveBeenCalled();
    expect(store.activityIds()).toEqual(["1", "2"]);
    expect(store.mentions()).toEqual([{ id: "1", actor: "Anna Rossi", preview: "look", chat: "Ops", channel: false, unread: true }]);
    expect(Object.fromEntries(store.activityAvatars())).toEqual({ "1": "anna.png", "2": "marco.png" });
  });

  it("reads it in the page when chatsvc refuses", async () => {
    const { a, tp } = agent("feed-token-2");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    expect(await readActivity(a)).toBeNull();
    expect(tp.clickRail).toHaveBeenCalled();
  });
});
