// Teams goes back to the self chat as soon as the app stops showing its chat, and back to the chat as soon as the app
// shows it again, not at the next fifth round: what arrives in the chat meanwhile would be read unseen (user
// 2026-09-30: a chat opened in the app, another tab, the messages turned read).
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "@/agent/context";
import { wanted } from "@/agent/jobs/page-setup";
import { agentJobs } from "@/agent/loop";
import { Scheduler } from "@/agent/scheduler";
import { SlotStore } from "@/agent/store/slot-store";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

const SELF = "Mario Rossi (You)";
let store: SlotStore;
// the chat Teams shows, and the chats the agent opened
let shown: string;
let opened: string[];

function agent() {
  const tp = {
    page: {},
    isOpen: async (chat: string) => chat === shown,
    openChat: async (chat: string) => {
      shown = chat;
      opened.push(chat);
    },
  };
  return { store, tp, config: { activity: false, readBy: false }, health: { teams: "ok" }, checkedOnly: () => false } as unknown as Agent;
}

// the parking job of the loop alone, one round a call, with the chat the loop wants
function loop(a: Agent) {
  const s = new Scheduler(
    agentJobs(a).filter((j) => j.name === "parking"),
    () => {},
  );
  return () => s.runRound({ onTeams: true, want: wanted(a) });
}

const app = (chat: string) => store.setState(STATE.viewing, JSON.stringify({ chat, ts: Math.floor(Date.now() / 1000) }));

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  store.saveChats(
    [SELF, "Anna Verdi"].map((name) => ({ name, preview: "", time: "", unread: false, mention: false, muted: false, av: "" })),
    true,
  );
  store.setState(STATE.activeChat, "Anna Verdi");
  shown = "Anna Verdi";
  opened = [];
});

describe("parking of the loop", () => {
  it("leaves the chat at the first round after the app stopped showing it, and opens it again at the first round it shows it", async () => {
    const round = loop(agent());
    app("Anna Verdi");
    for (let i = 0; i < 8; i++) await round();
    expect(opened).toEqual([]);
    // rounds 8 and 9: off the rounds parking has anyway (every fifth)
    app("");
    await round();
    expect(opened).toEqual([SELF]);
    app("Anna Verdi");
    await round();
    expect(opened).toEqual([SELF, "Anna Verdi"]);
  });
});
