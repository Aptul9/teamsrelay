import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_MAX_AGE, runCommand, runPendingCommands } from "@/agent/commands";
import type { Agent } from "@/agent/context";
import { NewMessageDetector } from "@/agent/logic/new-messages";
import { agentJobs } from "@/agent/loop";
import { Scheduler } from "@/agent/scheduler";
import type { Media } from "@/agent/media";
import type { Notifier } from "@/agent/push/notifier";
import { SlotStore } from "@/agent/store/slot-store";
import * as actions from "@/agent/teams/actions";
import * as mentionActions from "@/agent/teams/mentions";
import type { TeamsPage } from "@/agent/teams/page";
import type { PageMessage } from "@/agent/teams/scripts/conversation";
import { membersKey, STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

vi.mock("@/agent/teams/actions", () => ({
  sendText: vi.fn(async () => "sent" as const),
  replyWithQuote: vi.fn(async () => "sent" as const),
  react: vi.fn(async () => true),
  togglePill: vi.fn(async () => true),
  editMessage: vi.fn(async () => true),
  deleteMessage: vi.fn(async () => true),
  undoDelete: vi.fn(async () => true),
  readReceipts: vi.fn(async () => null),
  sendImage: vi.fn(async () => "sent" as const),
}));
vi.mock("@/agent/teams/mentions", () => ({
  readMembers: vi.fn(async () => ["ROSSI Anna", "BIANCHI Luca"]),
  sendWithMentions: vi.fn(async () => "sent" as const),
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
let downloaded: string | null;
let uploads: string;
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
    config: { uploadsDir: uploads, activity: true, readBy: true, answerCalls: false, alerts: { signInAfter: 60, browserAfter: 300, signIn: "Sign in again", browserDown: "The browser does not start" } },
    store,
    notifier: {
      push: async () => 0,
      alert: async (title: string, body: string) => alerts.push(`${title}: ${body}`),
      message: async () => undefined,
      deviceCount: () => 0,
    } as unknown as Notifier,
    media: { download: async () => downloaded, avatar: async () => "", avatars: async (_: unknown, rows: unknown[]) => rows, image: async () => null } as unknown as Media,
    detector: new NewMessageDetector(),
    tp,
    health: null,
  };
}

const cmd = (type: string, arg1 = "Anna Rossi", arg2 = "") => ({ id: 7, type, arg1, arg2 });
const db = () => (store as unknown as { db: import("better-sqlite3").Database }).db;

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  store.saveChats([{ name: "Anna Rossi", preview: "", time: "", unread: false, mention: false, muted: false, av: "" }]);
  opened = [];
  evaluated = [];
  opens = true;
  downloaded = null;
  uploads = tempDir();
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
    expect(db().prepare("SELECT mid, text FROM chat_messages WHERE chat=?").all("Anna Rossi")).toEqual([{ mid: "m1", text: "ciao" }]);
  });

  it("open: done even when the chat did not open, like the Python agent", async () => {
    opens = false;
    expect(await runCommand(agent(), cmd("open"))).toBe("done");
    expect(store.getState(STATE.activeChat)).toBe("");
  });

  it("send: done once Teams shows the message, failed when it does not, the conversation saved either way", async () => {
    expect(await runCommand(agent(), cmd("send", "Anna Rossi", "hello"))).toBe("done");
    expect(actions.sendText).toHaveBeenCalledWith(expect.anything(), "Anna Rossi", "hello", expect.any(Function));
    vi.mocked(actions.sendText).mockResolvedValueOnce("failed");
    evaluated = [];
    expect(await runCommand(agent(), cmd("send", "Anna Rossi", "hello again"))).toBe("failed");
    expect(evaluated).toContain("readMessages");
    expect(store.getState(STATE.activeChat)).toBe("Anna Rossi");
  });

  it("send and reply: unconfirmed when the message went out but Teams did not show it sent in time", async () => {
    vi.mocked(actions.sendText).mockResolvedValueOnce("unconfirmed");
    expect(await runCommand(agent(), cmd("send", "Anna Rossi", "hello"))).toBe("unconfirmed");
    vi.mocked(actions.replyWithQuote).mockResolvedValueOnce("unconfirmed");
    expect(await runCommand(agent(), cmd("reply", "Anna Rossi", '{"mid":"m1","text":"On it"}'))).toBe("unconfirmed");
    vi.mocked(mentionActions.sendWithMentions).mockResolvedValueOnce("unconfirmed");
    const parts = [{ text: "Hi " }, { mention: "ROSSI Anna" }];
    expect(await runCommand(agent(), cmd("sendmentions", "Anna Rossi", JSON.stringify({ parts })))).toBe("unconfirmed");
    expect(store.getState(STATE.activeChat)).toBe("Anna Rossi");
  });

  it("reply, edit, delete, undo: failed when Teams did not change, after saving the conversation", async () => {
    vi.mocked(actions.replyWithQuote).mockResolvedValueOnce("failed");
    expect(await runCommand(agent(), cmd("reply", "Anna Rossi", '{"mid":"m1","text":"On it"}'))).toBe("failed");
    expect(actions.replyWithQuote).toHaveBeenCalledWith(expect.anything(), "Anna Rossi", "m1", "On it", expect.any(Function));
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

  it("download: the file name goes in cmd_result", async () => {
    downloaded = "0123456789abcdef.pdf";
    expect(await runCommand(agent(), cmd("download", "https://contoso.sharepoint.com/a.pdf", '{"name":"a.pdf"}'))).toBe("done");
    expect(JSON.parse(store.getState("cmd_result:7"))).toEqual({ f: "0123456789abcdef.pdf" });
    downloaded = null;
    expect(await runCommand(agent(), { ...cmd("download", "https://contoso.sharepoint.com/b.pdf"), id: 8 })).toBe("failed");
    expect(store.getState("cmd_result:8")).toBe("");
  });

  it("sendimage: hands the upload to Teams with the caption, saves the conversation, deletes the upload", async () => {
    const png = Buffer.from("89504e470d0a1a0a0102", "hex");
    fs.writeFileSync(path.join(uploads, "0123456789abcdef.png"), png);
    expect(await runCommand(agent(), cmd("sendimage", "Anna Rossi", '{"file":"0123456789abcdef.png","text":"For you"}'))).toBe("done");
    expect(actions.sendImage).toHaveBeenCalledWith(expect.anything(), "Anna Rossi", { name: "image.png", type: "image/png", data: png }, "For you", expect.any(Function));
    expect(fs.readdirSync(uploads)).toEqual([]);
    expect(store.getState(STATE.activeChat)).toBe("Anna Rossi");
    expect(JSON.parse(store.getState(STATE.viewing)).chat).toBe("Anna Rossi");
    expect(evaluated).toContain("readMessages");
  });

  it("sendimage: failed when Teams did not show the image, the upload deleted all the same", async () => {
    vi.mocked(actions.sendImage).mockResolvedValueOnce("failed");
    fs.writeFileSync(path.join(uploads, "0123456789abcdef.jpg"), Buffer.from("ffd8ffe0", "hex"));
    expect(await runCommand(agent(), cmd("sendimage", "Anna Rossi", '{"file":"0123456789abcdef.jpg"}'))).toBe("failed");
    expect(actions.sendImage).toHaveBeenCalledWith(expect.anything(), "Anna Rossi", { name: "image.jpg", type: "image/jpeg", data: expect.any(Buffer) }, "", expect.any(Function));
    expect(fs.readdirSync(uploads)).toEqual([]);
  });

  it("sendimage: refuses a name outside the uploads and a missing file, without touching Teams", async () => {
    fs.writeFileSync(path.join(uploads, "secret.png"), "x");
    for (const file of ["../1/messages.db", "secret.png", "0123456789abcdef.png"]) {
      expect(await runCommand(agent(), cmd("sendimage", "Anna Rossi", JSON.stringify({ file })))).toBe("failed");
    }
    expect(actions.sendImage).not.toHaveBeenCalled();
    expect(fs.readdirSync(uploads)).toEqual(["secret.png"]);
  });

  it("members: saves the people Teams lists for the chat, with the time", async () => {
    expect(await runCommand(agent(), cmd("members", "Cloud team"))).toBe("done");
    expect(mentionActions.readMembers).toHaveBeenCalledWith(expect.anything(), "Cloud team");
    const saved = JSON.parse(store.getState(membersKey("Cloud team")));
    expect(saved).toEqual({ ts: expect.any(Number), names: ["ROSSI Anna", "BIANCHI Luca"] });
    expect(Math.abs(saved.ts - Date.now() / 1000)).toBeLessThan(5);
  });

  it("members: failed and nothing saved when the list could not be read", async () => {
    vi.mocked(mentionActions.readMembers).mockResolvedValueOnce(null);
    expect(await runCommand(agent(), cmd("members", "Cloud team"))).toBe("failed");
    expect(store.getState(membersKey("Cloud team"))).toBe("");
  });

  it("sendmentions: hands the parts to Teams, saves the conversation, done only when sent", async () => {
    const parts = [{ text: "Hi " }, { mention: "ROSSI Anna" }, { text: ", can you check?" }];
    expect(await runCommand(agent(), cmd("sendmentions", "Anna Rossi", JSON.stringify({ parts })))).toBe("done");
    expect(mentionActions.sendWithMentions).toHaveBeenCalledWith(expect.anything(), "Anna Rossi", parts, expect.any(Function));
    expect(evaluated).toContain("readMessages");
    vi.mocked(mentionActions.sendWithMentions).mockResolvedValueOnce("failed");
    expect(await runCommand(agent(), cmd("sendmentions", "Anna Rossi", JSON.stringify({ parts })))).toBe("failed");
  });

  it("sendmentions: nothing to send, nothing typed", async () => {
    expect(await runCommand(agent(), cmd("sendmentions", "Anna Rossi", "{"))).toBe("failed");
    expect(mentionActions.sendWithMentions).not.toHaveBeenCalled();
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
    vi.mocked(actions.replyWithQuote).mockResolvedValueOnce("failed");
    await runPendingCommands(agent());
    expect(db().prepare("SELECT type, status FROM commands ORDER BY id").all()).toEqual([
      { type: "open", status: "done" },
      { type: "reply", status: "failed" },
    ]);
    expect(evaluated.filter((n) => n === "readChatList")).toHaveLength(2);
  });

  it("never runs again a command the agent was running when it stopped: it ends unconfirmed", async () => {
    const id = store.enqueue("send", "Anna Rossi", "hello");
    // the agent is stopped (pm2 restart, crash) while Teams has not confirmed the message yet
    vi.mocked(actions.sendText).mockImplementationOnce(() => new Promise(() => undefined));
    void runPendingCommands(agent());
    await vi.waitFor(() => expect(actions.sendText).toHaveBeenCalledTimes(1));
    // the agent started again on the same database, well within two minutes
    await runPendingCommands(agent());
    expect(actions.sendText).toHaveBeenCalledTimes(1);
    expect(store.commandStatus(id)).toBe("unconfirmed");
    // a command queued after the restart runs as usual
    const next = store.enqueue("send", "Anna Rossi", "hello again");
    await runPendingCommands(agent());
    expect(store.commandStatus(next)).toBe("done");
  });

  it("checks the age of each command when its turn comes: one queued behind slow ones does not run late", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const insert = db().prepare("INSERT INTO commands(ts, type, arg1, arg2) VALUES(?, ?, ?, ?)");
      const now = Math.floor(Date.now() / 1000);
      insert.run(now, "send", "Anna Rossi", "first");
      // young enough when the round starts, too old once the first send took its time
      insert.run(now - 100, "send", "Anna Rossi", "second");
      vi.mocked(actions.sendText).mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 30_000);
        return "sent";
      });
      await runPendingCommands(agent());
      expect(actions.sendText).toHaveBeenCalledTimes(1);
      expect(db().prepare("SELECT arg2, status FROM commands ORDER BY id").all()).toEqual([
        { arg2: "first", status: "done" },
        { arg2: "second", status: "failed" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a refresh of the Activity feed pending while the side bar cannot be clicked, other commands go on", async () => {
    const a = agent();
    const refresh = store.enqueue("activity");
    const resync = store.enqueue("resync");
    a.railReady = false;
    await runPendingCommands(a);
    expect(store.commandStatus(refresh)).toBe("pending");
    expect(store.commandStatus(resync)).toBe("done");
    a.railReady = true;
    Object.assign(a.tp, { clearOverlays: async () => true, clickRail: async () => undefined });
    await runPendingCommands(a);
    expect(store.commandStatus(refresh)).toBe("failed");
  });

  it("keeps a check pending while the side bar cannot be clicked, like a refresh", async () => {
    const a = agent();
    const id = store.enqueue("check");
    a.railReady = false;
    await runPendingCommands(a);
    expect(store.commandStatus(id)).toBe("pending");
  });

  it("leaves answer and hangup to the call watch: the loop keeps them pending and never runs them", async () => {
    const answer = store.enqueue("answer", "Anna Rossi", '{"since":1790000000000}');
    const hangup = store.enqueue("hangup");
    const open = store.enqueue("open");
    await runPendingCommands(agent());
    expect(store.commandStatus(answer)).toBe("pending");
    expect(store.commandStatus(hangup)).toBe("pending");
    expect(store.commandStatus(open)).toBe("done");
    expect(evaluated.filter((n) => n === "readChatList")).toHaveLength(1);
  });

  it("answer and hangup handed to a handler end as failed with nothing done on Teams", async () => {
    expect(await runCommand(agent(), cmd("answer", "Anna Rossi", '{"since":1790000000000}'))).toBe("failed");
    expect(await runCommand(agent(), cmd("hangup", ""))).toBe("failed");
    expect(evaluated).toEqual([]);
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
  it("runs the steps of agent.py in its order and at its rounds", () => {
    const jobs = agentJobs(agent()).map((j) => [j.name, "seconds" in j.every ? `${j.every.seconds}s` : `${j.every.rounds}+${j.every.offset ?? 0}`, !!j.anyPage]);
    expect(jobs).toEqual([
      ["page", "1+0", false],
      ["input", "60s", false],
      ["parking", "5+2", false],
      ["hook", "1+0", false],
      ["commands", "1+0", false],
      ["chats-full", "300+1", false],
      ["chats", "3+0", false],
      ["activity", "150+5", false],
      ["identity", "300+7", false],
      ["health", "5+0", true],
      ["conversation", "1+0", false],
      ["read-by", "2+0", false],
      ["media", "300+31", false],
      ["self-check", "1+0", false],
    ]);
  });

  // right after a start the list is not drawn yet: a sweep for the chat found nothing and logged it not in the list
  it("parks Teams on a chat only once Teams shows its chat list, not while it starts or asks for a sign-in", () => {
    const a = agent();
    const job = agentJobs(a).find((j) => j.name === "parking");
    const want = { onTeams: true, want: "Anna Rossi (You)" };
    a.health = null;
    expect(job?.when?.(want)).toBe(false);
    a.health = { cdp: "ok", teams: "loading", overall: "yellow", ts: 1 };
    expect(job?.when?.(want)).toBe(false);
    a.health = { cdp: "ok", teams: "login", overall: "red", ts: 1 };
    expect(job?.when?.(want)).toBe(false);
    a.health = { cdp: "ok", teams: "ok", overall: "green", ts: 1 };
    expect(job?.when?.(want)).toBe(true);
  });

  it("reads the Activity feed once Teams shows a side bar it can click, as soon as that happens after a start", () => {
    const a = agent();
    const job = agentJobs(a).find((j) => j.name === "activity");
    expect(agentJobs(a).filter((j) => j.catchUp).map((j) => j.name)).toEqual(["activity"]);
    a.health = { cdp: "ok", teams: "ok", overall: "green", ts: 1 };
    a.railReady = false;
    expect(job?.when?.({ onTeams: true, want: "" })).toBe(false);
    a.railReady = true;
    expect(job?.when?.({ onTeams: true, want: "" })).toBe(true);
    a.health = { cdp: "ok", teams: "loading", overall: "yellow", ts: 1 };
    expect(job?.when?.({ onTeams: true, want: "" })).toBe(false);
  });

  it("reads the feed at the round after the health check found the side bar clickable, and once more 30 s after a failed read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const a = agent();
      let point: { x: number; y: number } | null = null;
      const evaluate = a.tp.page.evaluate.bind(a.tp.page) as (fn: { name: string }) => Promise<unknown>;
      Object.assign(a.tp.page, { evaluate: async (fn: { name: string }) => (fn.name === "uncoveredPoint" ? point : evaluate(fn)) });
      const reads: number[] = [];
      const s = new Scheduler(agentJobs(a).filter((j) => j.name === "activity" || j.name === "health"), () => {});
      Object.assign(a.tp, {
        clearOverlays: async () => true,
        clickRail: async (sel: string) => {
          if (sel.includes("Activity")) reads.push(s.round);
          throw new Error("no feed");
        },
      });
      const round = async (n: number) => {
        for (let i = 0; i < n; i++) await s.runRound({ onTeams: true, want: "" });
      };
      await round(8);
      expect(reads).toEqual([]);
      point = { x: 34, y: 70 };
      await round(5);
      expect(reads).toEqual([11]);
      vi.advanceTimersByTime(29_000);
      await round(2);
      expect(reads).toEqual([11]);
      vi.advanceTimersByTime(1_000);
      await round(1);
      expect(reads).toEqual([11, 15]);
      vi.advanceTimersByTime(60_000);
      await round(10);
      expect(reads).toEqual([11, 15]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves Teams nowhere while a call is in progress: parking, the full list, the feed, Read by and the check of the day wait", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 8, 27, 9, 0));
      const a = agent();
      a.health = { cdp: "ok", teams: "ok", overall: "green", ts: 1 };
      a.railReady = true;
      store.setState(STATE.activeChat, "Anna Rossi");
      const ctx = { onTeams: true, want: "Anna Rossi" };
      const waiting = ["parking", "chats-full", "activity", "read-by", "self-check"];
      const jobs = agentJobs(a).filter((j) => waiting.includes(j.name));
      expect(jobs.map((j) => [j.name, j.when?.(ctx)])).toEqual(waiting.map((n) => [n, true]));
      a.inCall = true;
      expect(jobs.map((j) => [j.name, j.when?.(ctx)])).toEqual(waiting.map((n) => [n, false]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs no automatic check of the day on an account the web app starts only to check it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 8, 27, 9, 0));
      const a = agent();
      const job = agentJobs(a).find((j) => j.name === "self-check");
      expect(job?.when?.({ onTeams: true, want: "" })).toBe(true);
      a.checkedOnly = () => true;
      expect(job?.when?.({ onTeams: true, want: "" })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves out the Activity feed and Read by for an app that does not show them", () => {
    const a = agent();
    a.config = { ...a.config, activity: false, readBy: false };
    expect(agentJobs(a).map((j) => j.name)).toEqual(["page", "input", "parking", "hook", "commands", "chats-full", "chats", "identity", "health", "conversation", "media", "self-check"]);
  });
});
