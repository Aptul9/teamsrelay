// A new message goes to the devices unless the app shows its chat now: Teams holds that chat open for the app and
// reads it there, and the app shows the message as it comes (prod 2026-09-30: a push for Cloud Competence Center at
// 12:58:51 while the app showed it since 12:58:06).
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/agent/context";
import { notifyNew } from "@/agent/jobs/chat-list";
import { drainHook } from "@/agent/jobs/page-setup";
import { NewMessageDetector } from "@/agent/logic/new-messages";
import { Notifier, type PushTarget } from "@/agent/push/notifier";
import { SlotStore } from "@/agent/store/slot-store";
import type { TeamsPage } from "@/agent/teams/page";
import type { ListRow } from "@/agent/teams/scripts/chat-list";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

let store: SlotStore;
let payloads: Record<string, unknown>[];

function agent(caught: { title: string; body: string }[] = []): Agent {
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
  return { store, notifier, tp, detector: new NewMessageDetector() } as unknown as Agent;
}

const row = (name: string, preview: string, time: string, unread = false): ListRow => ({ name, preview, time, unread, mention: false, muted: false, avsrc: "", presence: "", kind: "one" });
const now = () => Math.floor(Date.now() / 1000);
// the app shows `chat`, marked `age` seconds ago; Teams holds `active` open for it
function app(chat: string, age: number, active = chat) {
  store.setState(STATE.viewing, JSON.stringify({ chat, ts: now() - age }));
  store.setState(STATE.activeChat, active);
}

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "relay.db"));
  store.saveChats(["Anna Rossi", "Luca Bianchi"].map((name) => ({ name, preview: "", time: "", unread: false, mention: false, muted: false, av: "" })));
  payloads = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T12:58:51Z"));
});
afterEach(() => vi.useRealTimers());

describe("new messages of the chat list", () => {
  it("carry the time they were sent: the device keeps the newest of a chat", async () => {
    const a = agent();
    await notifyNew(a, [row("Anna Rossi", "ciao", "2:57 PM")]);
    await notifyNew(a, [row("Anna Rossi", "are you there?", "2:58 PM", true)]);
    expect(payloads).toEqual([{ title: "Anna Rossi", body: "are you there?", chat: "Anna Rossi", tag: "chat-0-Anna Rossi", ts: Date.parse("2026-09-30T12:58:51Z") }]);
  });

  it("go to no device while the app shows their chat and Teams holds it open", async () => {
    const a = agent();
    await notifyNew(a, [row("Anna Rossi", "ciao", "2:57 PM"), row("Luca Bianchi", "ok", "2:50 PM")]);
    app("Anna Rossi", 5);
    await notifyNew(a, [row("Anna Rossi", "are you there?", "2:58 PM"), row("Luca Bianchi", "deploy is green", "2:58 PM", true)]);
    expect(payloads.map((p) => p.body)).toEqual(["deploy is green"]);
    expect(store.lastNotificationTs()).toBeGreaterThan(0);
  });

  it("go out once the app stopped showing the chat, or stopped marking it", async () => {
    const a = agent();
    await notifyNew(a, [row("Anna Rossi", "ciao", "2:57 PM")]);
    app("", 1, "Anna Rossi");
    await notifyNew(a, [row("Anna Rossi", "are you there?", "2:58 PM", true)]);
    app("Anna Rossi", 60);
    await notifyNew(a, [row("Anna Rossi", "hello?", "2:58 PM", true)]);
    expect(payloads.map((p) => p.body)).toEqual(["are you there?", "hello?"]);
  });

  it("go out when Teams holds another chat than the one the app shows (its open not done yet)", async () => {
    const a = agent();
    await notifyNew(a, [row("Anna Rossi", "ciao", "2:57 PM")]);
    app("Anna Rossi", 1, "Luca Bianchi");
    await notifyNew(a, [row("Anna Rossi", "are you there?", "2:58 PM", true)]);
    expect(payloads.map((p) => p.body)).toEqual(["are you there?"]);
  });
});

describe("notifications caught from Teams", () => {
  it("go to no device for the chat the app shows", async () => {
    app("Anna Rossi", 5);
    await drainHook(agent([{ title: "Anna Rossi", body: "are you there?" }, { title: "Luca Bianchi", body: "deploy is green" }]));
    expect(payloads.map((p) => p.body)).toEqual(["deploy is green"]);
  });
});
