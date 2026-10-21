// Mentions of you in a muted chat or in a channel notify, as on Teams: the chat list stays quiet for them (a muted
// chat never notifies its messages, a channel is not in the list), the Activity feed lists them as "mentioned you"
// (prod 2026-10-21: "Cloud Operation e cazzate varie", muted, mention by FERRAIUOLO Salvatore at 9:30, no push).
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "@/agent/context";
import { notifyNew } from "@/agent/jobs/chat-list";
import { pushMentions } from "@/agent/jobs/mentions";
import { NewMessageDetector } from "@/agent/logic/new-messages";
import { Notifier, type PushTarget } from "@/agent/push/notifier";
import { SlotStore, type ActivityEntry } from "@/agent/store/slot-store";
import type { ListRow } from "@/agent/teams/scripts/chat-list";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

let store: SlotStore;
let payloads: Record<string, unknown>[];

function agent(): Agent {
  const devices = { targets: (): PushTarget[] => [{ endpoint: "https://push.example/phone", sub: '{"endpoint":"https://push.example/phone","keys":{"p256dh":"k","auth":"a"}}' }], remove: () => undefined };
  const notifier = new Notifier({
    store,
    devices,
    vapid: { publicKey: "BPublic", privateKey: "private" },
    subject: "mailto:relay@example.com",
    ntfy: null,
    send: async (_s, payload) => void payloads.push(JSON.parse(payload)),
  });
  return { store, notifier, detector: new NewMessageDetector() } as unknown as Agent;
}

const MUTED = "Cloud Operation e cazzate varie";
const mention = (id: string, chat: string, o: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id,
  kind: "mention",
  actor: "FERRAIUOLO Salvatore",
  title: "FERRAIUOLO Salvatore mentioned you",
  emoji: "",
  preview: "Antonio can you check the cluster?",
  tm: "9:30 AM",
  chat,
  channel: false,
  unread: true,
  av: "",
  ...o,
});
const row = (name: string, preview: string, time: string, muted = false): ListRow => ({ name, preview, time, unread: true, mention: false, muted, avsrc: "", presence: "", kind: "group" });

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  store.saveChats(
    [
      { name: MUTED, muted: true },
      { name: "Anna Rossi", muted: false },
    ].map(({ name, muted }) => ({ name, preview: "", time: "", unread: false, mention: false, muted, av: "" })),
  );
  payloads = [];
});

describe("mentions of you", () => {
  it("record the feed of a start without pushing the past", async () => {
    store.saveActivity([mention("m1", MUTED)]);
    expect(await pushMentions(agent())).toBe(0);
    expect(payloads).toEqual([]);
  });

  it("notify a new mention in a muted chat once, with who and the text, opening that chat", async () => {
    const a = agent();
    store.saveActivity([mention("m1", MUTED, { unread: false })]);
    await pushMentions(a);
    store.saveActivity([mention("m2", MUTED), mention("m1", MUTED, { unread: false })]);
    expect(await pushMentions(a)).toBe(1);
    expect(await pushMentions(a)).toBe(0);
    expect(payloads).toMatchObject([{ title: MUTED, body: "FERRAIUOLO Salvatore mentioned you: Antonio can you check the cluster?", chat: MUTED }]);
  });

  it("notify a mention in a channel, which the chat list does not show", async () => {
    const a = agent();
    await pushMentions(a);
    store.saveActivity([mention("c1", "Tesco Private Cloud › General", { channel: true, actor: "Tomrushka, Kat", preview: "please review" })]);
    await pushMentions(a);
    expect(payloads).toMatchObject([{ title: "Tesco Private Cloud › General", body: "Tomrushka, Kat mentioned you: please review", chat: "" }]);
  });

  it("leave a mention in a chat that is not muted to the chat list, and one already read", async () => {
    const a = agent();
    await pushMentions(a);
    store.saveActivity([mention("m3", "Anna Rossi"), mention("m4", MUTED, { unread: false })]);
    expect(await pushMentions(a)).toBe(0);
    expect(payloads).toEqual([]);
  });

  it("go to no device while the app shows that chat", async () => {
    const a = agent();
    await pushMentions(a);
    store.setState(STATE.viewing, JSON.stringify({ chat: MUTED, ts: Math.floor(Date.now() / 1000) }));
    store.setState(STATE.activeChat, MUTED);
    store.saveActivity([mention("m5", MUTED)]);
    expect(await pushMentions(a)).toBe(0);
  });

  it("are looked for in the feed when a muted chat shows something new, which itself pushes nothing", async () => {
    const a = agent();
    await notifyNew(a, [row(MUTED, "Salvatore: build is red", "9:29 AM", true)]);
    expect(a.mentionsDue).toBeFalsy();
    await notifyNew(a, [row(MUTED, "Salvatore: Antonio can you check the cluster?", "9:30 AM", true)]);
    expect(a.mentionsDue).toBe(true);
    expect(payloads).toEqual([]);
  });
});
