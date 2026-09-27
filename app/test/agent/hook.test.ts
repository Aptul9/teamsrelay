// Notifications Teams shows, caught by the hook in the page (a second source of new messages), as they reach the
// phone: the chat of the push is the one the app opens on a tap.
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "@/agent/context";
import { drainHook } from "@/agent/jobs/page-setup";
import { Notifier, type PushTarget } from "@/agent/push/notifier";
import { SlotStore } from "@/agent/store/slot-store";
import type { TeamsPage } from "@/agent/teams/page";
import { tempDir } from "../helpers";

let store: SlotStore;
let payloads: { title: string; body: string; chat: string }[];

function agent(caught: { title: string; body: string }[]): Agent {
  const devices = { targets: (): PushTarget[] => [{ endpoint: "https://push.example/phone", sub: '{"endpoint":"https://push.example/phone","keys":{"p256dh":"k","auth":"a"}}' }], remove: () => undefined };
  const notifier = new Notifier({
    store,
    devices,
    vapid: { publicKey: "BPublic", privateKey: "private" },
    subject: "mailto:relay@example.com",
    ntfy: null,
    send: async (_s, payload) => void payloads.push(JSON.parse(payload)),
  });
  const tp = { page: { evaluate: async () => caught } } as unknown as TeamsPage;
  return { store, notifier, tp } as unknown as Agent;
}

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "relay.db"));
  store.saveChats(["Anna Rossi", "Project Alpha"].map((name) => ({ name, preview: "", time: "", unread: false, mention: false, muted: false, av: "" })));
  payloads = [];
});

describe("notifications caught from Teams", () => {
  it("name the chat when the title of the notification is a chat of the list", async () => {
    await drainHook(agent([{ title: "Anna Rossi", body: "are you there?" }]));
    expect(payloads).toEqual([{ title: "Anna Rossi", body: "are you there?", chat: "Anna Rossi", tag: "chat-0-Anna Rossi" }]);
  });

  // in a group chat the title may be the person who wrote: a tap would open a chat that is not the one
  it("name no chat when the title is not a chat of the list", async () => {
    await drainHook(agent([{ title: "Luca Bianchi", body: "deploy is green" }]));
    expect(payloads).toEqual([{ title: "Luca Bianchi", body: "deploy is green", chat: "", tag: "chat-0-Luca Bianchi" }]);
    expect(store.lastNotificationTs()).toBeGreaterThan(0);
  });

  it("skip what Teams says about itself", async () => {
    await drainHook(agent([{ title: "Notifications are now on", body: "" }, { title: "__HEALTHCHECK__", body: "x" }]));
    expect(payloads).toEqual([]);
  });
});
