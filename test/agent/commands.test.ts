import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_MAX_AGE, runCommand, runPendingCommands } from "@/agent/commands";
import type { Agent } from "@/agent/context";
import { NewMessageDetector } from "@/agent/logic/new-messages";
import { agentJobs } from "@/agent/loop";
import type { Media } from "@/agent/media";
import type { Notifier } from "@/agent/push/notifier";
import { SlotStore } from "@/agent/store/slot-store";
import * as actions from "@/agent/teams/actions";
import type { TeamsPage } from "@/agent/teams/page";
import type { PageMessage } from "@/agent/teams/scripts/conversation";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

vi.mock("@/agent/teams/actions", () => ({
  sendText: vi.fn(async () => true),
  replyWithQuote: vi.fn(async () => true),
  react: vi.fn(async () => true),
  togglePill: vi.fn(async () => true),
  editMessage: vi.fn(async () => true),
  deleteMessage: vi.fn(async () => true),
  undoDelete: vi.fn(async () => true),
}));

const message = (mid: string, text: string): PageMessage => ({
  mid,
  author: "Anna Rossi",
  text,
  mine: false,
  reacts: "",
  quote: null,
  images: [],
  files: [],
  reactions: [],
  status: "",
  edited: false,
  html: text,
  mentionsMe: false,
  avsrc: "",
  deleted: false,
});

let store: SlotStore;
let opened: string[];
let evaluated: string[];
let opens: boolean;
let alerts: string[];

function agent(): Agent {
  const page = {
    url: () => "https://teams.cloud.microsoft/v2/",
    evaluate: async (fn: { name: string }) => {
      evaluated.push(fn.name);
      if (fn.name === "readMessages") return [message("m1", "ciao")];
      if (fn.name === "readChatList") return [];
      if (fn.name === "probePage") return { reduced: false, domReady: true, hookInstalled: true, presence: "available" };
      return null;
    },
  };
  const tp = {
    page,
    openChat: async (chat: string) => {
      opened.push(chat);
      return opens;
    },
    isOpen: async () => opens,
  } as unknown as TeamsPage;
  return {
    config: { hostLabel: "test-pc", alerts: { signInAfter: 60, browserAfter: 300 } } as Agent["config"],
    store,
    notifier: { push: async () => 0, alert: async (title: string, body: string) => alerts.push(`${title}: ${body}`), message: async () => undefined } as unknown as Notifier,
    media: { avatar: async () => "", avatars: async (_: unknown, rows: unknown[]) => rows, image: async () => null } as unknown as Media,
    detector: new NewMessageDetector(),
    tp,
    health: null,
  };
}

const cmd = (type: string, arg1 = "Anna Rossi", arg2 = "") => ({ id: 7, type, arg1, arg2 });
const db = () => (store as unknown as { db: import("better-sqlite3").Database }).db;

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "relay.db"));
  store.saveChats([{ name: "Anna Rossi", preview: "", time: "", unread: false, mention: false, muted: false, av: "" }]);
  opened = [];
  evaluated = [];
  opens = true;
  alerts = [];
  vi.clearAllMocks();
});

describe("command handlers", () => {
  it("open: shows the chat, saves its messages, marks it in use", async () => {
    expect(await runCommand(agent(), cmd("open"))).toBe("done");
    expect(opened).toEqual(["Anna Rossi"]);
    expect(store.getState(STATE.activeChat)).toBe("Anna Rossi");
    expect(JSON.parse(store.getState(STATE.viewing)).chat).toBe("Anna Rossi");
    expect(evaluated).toContain("readMessages");
    expect(store.messages("Anna Rossi").map((m) => [m.mid, m.text])).toEqual([["m1", "ciao"]]);
  });

  it("open: done even when the chat did not open, like the Python agent", async () => {
    opens = false;
    expect(await runCommand(agent(), cmd("open"))).toBe("done");
    expect(store.getState(STATE.activeChat)).toBe("");
  });

  it("send: done once Teams shows the message, failed when it does not, the conversation saved either way", async () => {
    expect(await runCommand(agent(), cmd("send", "Anna Rossi", "hello"))).toBe("done");
    expect(actions.sendText).toHaveBeenCalledWith(expect.anything(), "Anna Rossi", "hello");
    vi.mocked(actions.sendText).mockResolvedValueOnce(false);
    evaluated = [];
    expect(await runCommand(agent(), cmd("send", "Anna Rossi", "hello again"))).toBe("failed");
    expect(evaluated).toContain("readMessages");
    expect(store.getState(STATE.activeChat)).toBe("Anna Rossi");
  });

  it("reply, edit, delete, undo: failed when Teams did not change, after saving the conversation", async () => {
    vi.mocked(actions.replyWithQuote).mockResolvedValueOnce(false);
    expect(await runCommand(agent(), cmd("reply", "Anna Rossi", '{"mid":"m1","text":"On it"}'))).toBe("failed");
    expect(actions.replyWithQuote).toHaveBeenCalledWith(expect.anything(), "Anna Rossi", "m1", "On it");
    expect(store.getState(STATE.activeChat)).toBe("Anna Rossi");
    expect(await runCommand(agent(), cmd("edit", "Anna Rossi", '{"mid":"m1","text":"fixed"}'))).toBe("done");
    expect(await runCommand(agent(), cmd("delete", "Anna Rossi", '{"mid":"m1"}'))).toBe("done");
    expect(await runCommand(agent(), cmd("undodelete", "Anna Rossi", '{"mid":"m1"}'))).toBe("done");
    expect(actions.undoDelete).toHaveBeenCalledWith(expect.anything(), "Anna Rossi", "m1");
  });

  it("react: a pill click or a reaction of the bar", async () => {
    await runCommand(agent(), cmd("react", "Anna Rossi", '{"mid":"m1","pill":"👍"}'));
    await runCommand(agent(), cmd("react", "Anna Rossi", '{"mid":"m1","emoji":"heart"}'));
    expect(actions.togglePill).toHaveBeenCalledWith(expect.anything(), "Anna Rossi", "m1", "👍");
    expect(actions.react).toHaveBeenCalledWith(expect.anything(), "Anna Rossi", "m1", "heart");
  });

  it("recheck: pushes the outcome of the check", async () => {
    expect(await runCommand(agent(), cmd("recheck", ""))).toBe("done");
    expect(alerts).toEqual(["Teams: Problem: Chat list not readable"]);
  });

  it("an unknown type is done, a handler that throws is failed", async () => {
    expect(await runCommand(agent(), cmd("teleport"))).toBe("done");
    vi.mocked(actions.editMessage).mockRejectedValueOnce(new Error("Target page, context or browser has been closed"));
    expect(await runCommand(agent(), cmd("edit", "Anna Rossi", '{"mid":"m1","text":"x"}'))).toBe("failed");
  });

  it("runs the pending commands in order, records each outcome and reads the chat list after each", async () => {
    const insert = db().prepare("INSERT INTO commands(ts, type, arg1, arg2) VALUES(?, ?, ?, ?)");
    const now = Math.floor(Date.now() / 1000);
    insert.run(now, "open", "Anna Rossi", "");
    insert.run(now, "reply", "Anna Rossi", '{"mid":"m1","text":"x"}');
    vi.mocked(actions.replyWithQuote).mockResolvedValueOnce(false);
    await runPendingCommands(agent());
    expect(db().prepare("SELECT type, status FROM commands ORDER BY id").all()).toEqual([
      { type: "open", status: "done" },
      { type: "reply", status: "failed" },
    ]);
    expect(evaluated.filter((n) => n === "readChatList")).toHaveLength(2);
  });

  it("never runs a command that waited too long: a send queued while Teams was down stays unsent", async () => {
    const insert = db().prepare("INSERT INTO commands(ts, type, arg1, arg2) VALUES(?, ?, ?, ?)");
    insert.run(Math.floor(Date.now() / 1000) - COMMAND_MAX_AGE - 5, "send", "Anna Rossi", "from an hour ago");
    await runPendingCommands(agent());
    expect(actions.sendText).not.toHaveBeenCalled();
    expect(db().prepare("SELECT status FROM commands").pluck().all()).toEqual(["failed"]);
  });
});

describe("agent loop", () => {
  it("runs the steps of agent.py in its order and at its rounds, less Activity and Read by", () => {
    const jobs = agentJobs(agent()).map((j) => [j.name, "seconds" in j.every ? `${j.every.seconds}s` : `${j.every.rounds}+${j.every.offset ?? 0}`, !!j.anyPage]);
    expect(jobs).toEqual([
      ["page", "1+0", false],
      ["input", "60s", false],
      ["parking", "5+2", false],
      ["hook", "1+0", false],
      ["commands", "1+0", false],
      ["chats-full", "300+1", false],
      ["chats", "3+0", false],
      ["identity", "300+7", false],
      ["health", "5+0", true],
      ["conversation", "1+0", false],
      ["self-check", "1+0", false],
    ]);
  });
});
