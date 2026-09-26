import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand, runPendingCommands } from "@/agent/commands";
import type { Agent } from "@/agent/context";
import { NewMessageDetector } from "@/agent/logic/new-messages";
import { agentJobs } from "@/agent/loop";
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
  sendText: vi.fn(async () => true),
  replyWithQuote: vi.fn(async () => true),
  react: vi.fn(async () => true),
  togglePill: vi.fn(async () => true),
  editMessage: vi.fn(async () => true),
  deleteMessage: vi.fn(async () => true),
  undoDelete: vi.fn(async () => true),
  readReceipts: vi.fn(async () => null),
  sendImage: vi.fn(async () => true),
}));
vi.mock("@/agent/teams/mentions", () => ({
  readMembers: vi.fn(async () => ["ROSSI Anna", "BIANCHI Luca"]),
  sendWithMentions: vi.fn(async () => true),
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

function agent(): Agent {
  const page = {
    url: () => "https://teams.cloud.microsoft/v2/",
    evaluate: async (fn: { name: string }) => {
      evaluated.push(fn.name);
      if (fn.name === "readMessages") return [message("m1", "ciao")];
      if (fn.name === "readChatList") return [];
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
    config: { uploadsDir: uploads, activity: true, readBy: true },
    store,
    notifier: { push: async () => 0, message: async () => undefined } as unknown as Notifier,
    media: { download: async () => downloaded, avatar: async () => "", avatars: async (_: unknown, rows: unknown[]) => rows, image: async () => null } as unknown as Media,
    detector: new NewMessageDetector(),
    tp,
    health: null,
  };
}

const cmd = (type: string, arg1 = "Anna Rossi", arg2 = "") => ({ id: 7, type, arg1, arg2 });

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  store.saveChats([{ name: "Anna Rossi", preview: "", time: "", unread: false, mention: false, muted: false, av: "" }]);
  opened = [];
  evaluated = [];
  opens = true;
  downloaded = null;
  uploads = tempDir();
  vi.clearAllMocks();
});

describe("command handlers", () => {
  it("open: shows the chat, saves its messages, marks it in use", async () => {
    expect(await runCommand(agent(), cmd("open"))).toBe("done");
    expect(opened).toEqual(["Anna Rossi"]);
    expect(store.getState(STATE.activeChat)).toBe("Anna Rossi");
    expect(JSON.parse(store.getState(STATE.viewing)).chat).toBe("Anna Rossi");
    expect(evaluated).toContain("readMessages");
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    expect(db.prepare("SELECT mid, text FROM chat_messages WHERE chat=?").all("Anna Rossi")).toEqual([{ mid: "m1", text: "ciao" }]);
  });

  it("open: done even when the chat did not open, like the Python agent", async () => {
    opens = false;
    expect(await runCommand(agent(), cmd("open"))).toBe("done");
    expect(store.getState(STATE.activeChat)).toBe("");
  });

  it("send: done whatever happened, with the conversation saved", async () => {
    vi.mocked(actions.sendText).mockResolvedValueOnce(false);
    expect(await runCommand(agent(), cmd("send", "Anna Rossi", "hello"))).toBe("done");
    expect(actions.sendText).toHaveBeenCalledWith(expect.anything(), "Anna Rossi", "hello");
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
    expect(actions.sendImage).toHaveBeenCalledWith(expect.anything(), "Anna Rossi", { name: "image.png", type: "image/png", data: png }, "For you");
    expect(fs.readdirSync(uploads)).toEqual([]);
    expect(store.getState(STATE.activeChat)).toBe("Anna Rossi");
    expect(JSON.parse(store.getState(STATE.viewing)).chat).toBe("Anna Rossi");
    expect(evaluated).toContain("readMessages");
  });

  it("sendimage: failed when Teams did not show the image, the upload deleted all the same", async () => {
    vi.mocked(actions.sendImage).mockResolvedValueOnce(false);
    fs.writeFileSync(path.join(uploads, "0123456789abcdef.jpg"), Buffer.from("ffd8ffe0", "hex"));
    expect(await runCommand(agent(), cmd("sendimage", "Anna Rossi", '{"file":"0123456789abcdef.jpg"}'))).toBe("failed");
    expect(actions.sendImage).toHaveBeenCalledWith(expect.anything(), "Anna Rossi", { name: "image.jpg", type: "image/jpeg", data: expect.any(Buffer) }, "");
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
    expect(mentionActions.sendWithMentions).toHaveBeenCalledWith(expect.anything(), "Anna Rossi", parts);
    expect(evaluated).toContain("readMessages");
    vi.mocked(mentionActions.sendWithMentions).mockResolvedValueOnce(false);
    expect(await runCommand(agent(), cmd("sendmentions", "Anna Rossi", JSON.stringify({ parts })))).toBe("failed");
  });

  it("sendmentions: nothing to send, nothing typed", async () => {
    expect(await runCommand(agent(), cmd("sendmentions", "Anna Rossi", "{"))).toBe("failed");
    expect(mentionActions.sendWithMentions).not.toHaveBeenCalled();
  });

  it("an unknown type is done, a handler that throws is failed", async () => {
    expect(await runCommand(agent(), cmd("teleport"))).toBe("done");
    vi.mocked(actions.editMessage).mockRejectedValueOnce(new Error("Target page, context or browser has been closed"));
    expect(await runCommand(agent(), cmd("edit", "Anna Rossi", '{"mid":"m1","text":"x"}'))).toBe("failed");
  });

  it("runs the pending commands in order, records each outcome and reads the chat list after each", async () => {
    const a = agent();
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    const insert = db.prepare("INSERT INTO commands(ts, type, arg1, arg2) VALUES(0, ?, ?, ?)");
    insert.run("open", "Anna Rossi", "");
    insert.run("reply", "Anna Rossi", '{"mid":"m1","text":"x"}');
    vi.mocked(actions.replyWithQuote).mockResolvedValueOnce(false);
    await runPendingCommands(a);
    expect(db.prepare("SELECT type, status FROM commands ORDER BY id").all()).toEqual([
      { type: "open", status: "done" },
      { type: "reply", status: "failed" },
    ]);
    expect(evaluated.filter((n) => n === "readChatList")).toHaveLength(2);
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
      ["self-check", "1+0", false],
    ]);
  });
});
