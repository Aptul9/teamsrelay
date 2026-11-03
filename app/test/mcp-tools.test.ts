import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appDb, claimSlot, migrateAppSchema, setSlotStopped } from "@/lib/appdb";
import {
  deleteMessage,
  editMessage,
  getAttachment,
  listAccounts,
  listActivity,
  listChats,
  messageTime,
  reactMessage,
  readChat,
  refreshChat,
  sendMessage,
  undoDelete,
} from "@/lib/mcp/tools";
import { createSlotDb, tempDir } from "./helpers";

let mine: number;
let other: number;
let empty: number;
let db: Database.Database;
let dataDir: string;

const now = () => Math.floor(Date.now() / 1000);
const setState = (k: string, v: string) => db.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)").run(k, v);
const health = (teams = "ok") => setState("health", JSON.stringify({ cdp: "ok", ts: now(), teams, overall: "green" }));

beforeAll(() => {
  dataDir = tempDir();
  process.env.APP_DB = path.join(dataDir, "app.db");
  migrateAppSchema(appDb());
  const limits = { perUser: 4 };
  mine = claimSlot(appDb(), "u1", limits);
  other = claimSlot(appDb(), "u2", limits);
  empty = claimSlot(appDb(), "u1", limits);
  db = createSlotDb(path.join(dataDir, String(mine), "messages.db"));
});

beforeEach(() => {
  setSlotStopped(appDb(), mine, false);
  db.exec("DELETE FROM chats; DELETE FROM chat_messages; DELETE FROM activity; DELETE FROM commands; DELETE FROM state");
  health();
  setState("me", JSON.stringify({ name: "ROSSI Anna", email: "anna@contoso.example", tenant: "Contoso", av: "" }));
  const chat = db.prepare("INSERT INTO chats(name, preview, pos, tm, unread, mention, muted) VALUES(?,?,?,?,?,?,?)");
  chat.run("BIANCHI Luca", "See you at 3", 0, "14:07", 1, 0, 0);
  chat.run("Cloud team", "Deploy done", 1, "Yesterday", 0, 1, 0);
  chat.run("ROSSI Anna (You)", "note", 2, "9/22", 0, 0, 1);
  const msg = db.prepare("INSERT INTO chat_messages(chat, idx, mid, author, text, mine, reacts, extra) VALUES(?,?,?,?,?,?,?,?)");
  msg.run("BIANCHI Luca", 0, "1790431027228", "BIANCHI Luca", "Can you check the pipeline?", 0, "", JSON.stringify({ reactions: [{ e: "like", n: 2, mine: true }], images: [{ f: "a.webp", w: 10, h: 10 }], mentionsMe: true }));
  msg.run("BIANCHI Luca", 1, "1790431664072", "ROSSI Anna", "Done", 1, "", JSON.stringify({ quote: { author: "BIANCHI Luca", text: "Can you check the pipeline?" }, files: [{ name: "report.xlsx", url: "https://contoso.sharepoint.com/x" }], edited: true }));
  msg.run("BIANCHI Luca", 2, "temp-1", "BIANCHI Luca", "", 0, "", JSON.stringify({ deleted: true }));
  const act = db.prepare("INSERT INTO activity(id, pos, kind, actor, title, emoji, preview, tm, chat, unread, channel) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  act.run("a1", 0, "mention", "BIANCHI Luca", "mentioned you", "", "@Anna see this", "14:00", "Cloud team", 1, 0);
  act.run("a2", 1, "reaction", "VERDI Carla", "reacted to your message", "heart", "Done", "Yesterday", "BIANCHI Luca", 0, 0);
  setState("activity_ts", "1790431000");
});

describe("list_accounts", () => {
  it("gives the accounts of the user only, with their state", () => {
    const { accounts } = listAccounts("u1");
    expect(accounts.map((a) => a.slot)).toEqual([mine, empty]);
    expect(accounts[0]).toEqual({ slot: mine, name: "ROSSI Anna", email: "anna@contoso.example", tenant: "Contoso", teams: "ok", overall: "green", stopped: false, unread: 1 });
    expect(accounts[1]).toMatchObject({ slot: empty, teams: "starting" });
  });
});

describe("list_chats", () => {
  it("gives the chat list as Teams shows it, flags only when set", () => {
    expect(listChats("u1", {})).toEqual({
      account: mine,
      chats: [
        { name: "BIANCHI Luca", preview: "See you at 3", last: "14:07", unread: true },
        { name: "Cloud team", preview: "Deploy done", last: "Yesterday", unread: false, mention: true },
        { name: "ROSSI Anna (You)", preview: "note", last: "9/22", unread: false, muted: true },
      ],
    });
  });

  it("keeps the unread ones on request", () => {
    expect(listChats("u1", { unread_only: true }).chats.map((c) => c.name)).toEqual(["BIANCHI Luca"]);
  });

  it("marks the chat open in Teams: in use within 30 s and not left, agent and Teams working", () => {
    setState("active_chat", "Cloud team");
    setState("viewing", JSON.stringify({ chat: "Cloud team", ts: now() }));
    expect(listChats("u1", {}).chats.filter((c) => c.open).map((c) => c.name)).toEqual(["Cloud team"]);
    setState("viewing", JSON.stringify({ chat: "Cloud team", ts: now() - 31 }));
    expect(listChats("u1", {}).chats.some((c) => c.open)).toBe(false);
    setState("viewing", JSON.stringify({ chat: "", ts: now() }));
    expect(listChats("u1", {}).chats.some((c) => c.open)).toBe(false);
    setState("viewing", JSON.stringify({ chat: "Cloud team", ts: now() }));
    health("login");
    expect(listChats("u1", {}).chats.some((c) => c.open)).toBe(false);
  });
});

describe("read_chat", () => {
  it("gives the saved messages with their time, oldest first", () => {
    expect(readChat("u1", { chat: "BIANCHI Luca" })).toEqual({
      account: mine,
      chat: "BIANCHI Luca",
      live: false,
      messages: [
        { id: "1790431027228", time: "2026-09-26T13:57:07.228Z", author: "BIANCHI Luca", mine: false, text: "Can you check the pipeline?", reactions: [{ emoji: "like", count: 2, mine: true }], images: 1, mentions_me: true },
        { id: "1790431664072", time: "2026-09-26T14:07:44.072Z", author: "ROSSI Anna", mine: true, text: "Done", quote: { author: "BIANCHI Luca", text: "Can you check the pipeline?" }, files: ["report.xlsx"], edited: true },
        { id: "temp-1", author: "BIANCHI Luca", mine: false, text: "", deleted: true },
      ],
    });
  });

  it("says the messages are current while the chat is open in Teams", () => {
    setState("active_chat", "BIANCHI Luca");
    setState("viewing", JSON.stringify({ chat: "BIANCHI Luca", ts: now() }));
    expect(readChat("u1", { chat: "BIANCHI Luca" }).live).toBe(true);
  });

  it("says how to get the messages of a chat never opened", () => {
    const r = readChat("u1", { chat: "Cloud team" });
    expect(r.messages).toEqual([]);
    expect(r.note).toMatch(/refresh_chat/);
  });

  it("refuses a chat that is not in the list and has no messages", () => {
    expect(() => readChat("u1", { chat: "Nobody" })).toThrow(/list_chats/);
  });

  it("answers only for accounts of the user that have a database", () => {
    expect(() => readChat("u1", { account: other, chat: "BIANCHI Luca" })).toThrow("Account not found");
    expect(() => readChat("u1", { account: 99, chat: "BIANCHI Luca" })).toThrow("Account not found");
    expect(() => readChat("u1", { account: empty, chat: "BIANCHI Luca" })).toThrow("Account not ready yet");
  });
});

describe("message time", () => {
  it("comes from Teams message ids, milliseconds since 1970", () => {
    expect(messageTime("1790431664072")).toBe("2026-09-26T14:07:44.072Z");
    expect(messageTime("temp-1")).toBeUndefined();
    expect(messageTime("123")).toBeUndefined();
  });
});

describe("list_activity", () => {
  it("gives the Activity feed as last read", () => {
    expect(listActivity("u1", {})).toEqual({
      account: mine,
      read_at: "2026-09-26T13:56:40.000Z",
      items: [
        { kind: "mention", actor: "BIANCHI Luca", title: "mentioned you", preview: "@Anna see this", time: "14:00", chat: "Cloud team", unread: true },
        { kind: "reaction", actor: "VERDI Carla", title: "reacted to your message", emoji: "heart", preview: "Done", time: "Yesterday", chat: "BIANCHI Luca", unread: false },
      ],
    });
    expect(listActivity("u1", { unread_only: true }).items).toHaveLength(1);
  });
});

describe("refresh_chat", () => {
  let stopAgent: (() => void) | undefined;
  afterEach(() => stopAgent?.());

  // The agent runs an open command: the chat is in use from now, Teams opens it when it can, its messages are saved
  function agent(outcome: "opens" | "does-not-open" | "fails") {
    const timer = setInterval(() => {
      const cmd = db.prepare("SELECT id, arg1 FROM commands WHERE type='open' AND status='pending'").get() as { id: number; arg1: string } | undefined;
      if (!cmd) return;
      setState("viewing", JSON.stringify({ chat: cmd.arg1, ts: now() }));
      if (outcome === "opens") {
        setState("active_chat", cmd.arg1);
        db.prepare("INSERT INTO chat_messages(chat, idx, mid, author, text, mine, reacts, extra) VALUES(?,?,?,?,?,?,?,?)").run(cmd.arg1, 0, "1790432000000", "VERDI Carla", "New here", 0, "", "");
      }
      db.prepare("UPDATE commands SET status=? WHERE id=?").run(outcome === "fails" ? "failed" : "done", cmd.id);
    }, 20);
    stopAgent = () => clearInterval(timer);
  }
  const fast = { timeoutMs: 1000, pollMs: 20 };
  const commands = () => db.prepare("SELECT type, arg1, status FROM commands").all();

  it("opens the chat in Teams and gives its current messages", async () => {
    agent("opens");
    const r = await refreshChat("u1", { chat: "Cloud team" }, fast);
    expect(r.live).toBe(true);
    expect(r.messages).toEqual([{ id: "1790432000000", time: "2026-09-26T14:13:20.000Z", author: "VERDI Carla", mine: false, text: "New here" }]);
    expect(commands()).toEqual([{ type: "open", arg1: "Cloud team", status: "done" }]);
  });

  it("says so when Teams did not open the chat", async () => {
    setState("active_chat", "BIANCHI Luca");
    agent("does-not-open");
    await expect(refreshChat("u1", { chat: "Cloud team" }, fast)).rejects.toThrow(/did not open/);
  });

  it("says so when the command failed", async () => {
    agent("fails");
    await expect(refreshChat("u1", { chat: "Cloud team" }, fast)).rejects.toThrow(/could not open/);
  });

  it("gives up after the timeout", async () => {
    await expect(refreshChat("u1", { chat: "Cloud team" }, { timeoutMs: 100, pollMs: 20 })).rejects.toThrow(/within/);
  });

  it("queues nothing for an unknown chat, a stopped account or a Teams not working", async () => {
    await expect(refreshChat("u1", { chat: "Nobody" }, fast)).rejects.toThrow(/list_chats/);
    health("login");
    await expect(refreshChat("u1", { chat: "Cloud team" }, fast)).rejects.toThrow(/not working/);
    health();
    setSlotStopped(appDb(), mine, true);
    await expect(refreshChat("u1", { chat: "Cloud team" }, fast)).rejects.toThrow(/stopped/);
    expect(commands()).toEqual([]);
  });
});

// The agent of the account: runs every pending command of these types with this outcome; a message sent becomes a
// message of the account in the chat, a download writes its file
function fakeAgent(outcome: "done" | "failed" = "done") {
  const timer = setInterval(() => {
    const cmds = db.prepare("SELECT id, type, arg1, arg2 FROM commands WHERE status='pending'").all() as { id: number; type: string; arg1: string; arg2: string }[];
    for (const c of cmds) {
      if (outcome === "done" && ["send", "sendmentions", "reply", "sendimage"].includes(c.type)) {
        const idx = (db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat=?").get(c.arg1) as { n: number }).n;
        db.prepare("INSERT INTO chat_messages(chat, idx, mid, author, text, mine, reacts, extra) VALUES(?,?,?,?,?,?,?,?)").run(c.arg1, idx, "1790433000000", "ROSSI Anna", "sent", 1, "", "");
      }
      if (outcome === "done" && c.type === "download") {
        fs.mkdirSync(path.join(dataDir, String(mine), "files"), { recursive: true });
        fs.writeFileSync(path.join(dataDir, String(mine), "files", "0123456789abcdef.csv"), "a,b\n1,2\n");
        setState(`cmd_result:${c.id}`, JSON.stringify({ f: "0123456789abcdef.csv" }));
      }
      db.prepare("UPDATE commands SET status=? WHERE id=?").run(outcome, c.id);
    }
  }, 20);
  return () => clearInterval(timer);
}

const fast = { timeoutMs: 1000, pollMs: 20 };
const queued = () => db.prepare("SELECT type, arg1, arg2 FROM commands ORDER BY id").all() as { type: string; arg1: string; arg2: string }[];
// smallest PNG: the signature is what the server checks
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(16)]);

describe("send_message", () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it("sends text and answers with the message saved after", async () => {
    stop = fakeAgent();
    const r = await sendMessage("u1", { chat: "BIANCHI Luca", text: "Ciao 👋" }, fast);
    expect(r).toMatchObject({ account: mine, chat: "BIANCHI Luca", status: "done", message: { id: "1790433000000", mine: true, text: "sent" } });
    expect(queued()).toEqual([{ type: "send", arg1: "BIANCHI Luca", arg2: "Ciao 👋" }]);
  });

  it("tags the people of mentions, replies with quote, sends an image with its caption", async () => {
    stop = fakeAgent();
    await sendMessage("u1", { chat: "Cloud team", text: "@VERDI Carla look", mentions: ["VERDI Carla"] }, fast);
    await sendMessage("u1", { chat: "BIANCHI Luca", text: "On it", reply_to: "1790431027228" }, fast);
    await sendMessage("u1", { chat: "BIANCHI Luca", text: "screen", image: `data:image/png;base64,${PNG.toString("base64")}` }, fast);
    const [mention, reply, image] = queued();
    expect(mention).toEqual({ type: "sendmentions", arg1: "Cloud team", arg2: JSON.stringify({ parts: [{ mention: "VERDI Carla" }, { text: " look" }] }) });
    expect(reply).toEqual({ type: "reply", arg1: "BIANCHI Luca", arg2: JSON.stringify({ mid: "1790431027228", text: "On it" }) });
    expect(image.type).toBe("sendimage");
    const { file, text } = JSON.parse(image.arg2) as { file: string; text: string };
    expect(text).toBe("screen");
    expect(file).toMatch(/^[0-9a-f]{16}\.png$/);
    expect(fs.readFileSync(path.join(dataDir, String(mine), "uploads", file))).toEqual(PNG);
  });

  it("queues nothing for what cannot go", async () => {
    await expect(sendMessage("u1", { chat: "BIANCHI Luca", text: " " }, fast)).rejects.toThrow(/text is required/);
    await expect(sendMessage("u1", { chat: "BIANCHI Luca", image: PNG.toString("base64"), reply_to: "1" }, fast)).rejects.toThrow(/alone/);
    await expect(sendMessage("u1", { chat: "BIANCHI Luca", image: Buffer.from("not an image").toString("base64") }, fast)).rejects.toThrow(/PNG, JPEG/);
    await expect(sendMessage("u1", { chat: "Nobody", text: "hi" }, fast)).rejects.toThrow(/list_chats/);
    health("login");
    await expect(sendMessage("u1", { chat: "BIANCHI Luca", text: "hi" }, fast)).rejects.toThrow(/not working/);
    expect(queued()).toEqual([]);
  });

  it("says when Teams did not confirm, and when the command still waits", async () => {
    stop = fakeAgent("failed");
    await expect(sendMessage("u1", { chat: "BIANCHI Luca", text: "hi" }, fast)).rejects.toThrow(/did not confirm/);
    stop();
    const r = await sendMessage("u1", { chat: "BIANCHI Luca", text: "hi" }, { timeoutMs: 60, pollMs: 20 });
    expect(r).toMatchObject({ status: "pending", note: expect.stringMatching(/Queued/) });
  });
});

describe("react, edit, delete, undo delete", () => {
  let stop: (() => void) | undefined;
  beforeEach(() => (stop = fakeAgent()));
  afterEach(() => stop?.());

  it("queues the command of the app on the message and answers with the message", async () => {
    const r = await reactMessage("u1", { chat: "BIANCHI Luca", message_id: "1790431027228", reaction: "Heart" }, fast);
    expect(r).toMatchObject({ status: "done", message: { id: "1790431027228", author: "BIANCHI Luca" } });
    await reactMessage("u1", { chat: "BIANCHI Luca", message_id: "1790431027228", reaction: "👍" }, fast);
    await editMessage("u1", { chat: "BIANCHI Luca", message_id: "1790431664072", text: "Done ✅" }, fast);
    await deleteMessage("u1", { chat: "BIANCHI Luca", message_id: "1790431664072" }, fast);
    await undoDelete("u1", { chat: "BIANCHI Luca", message_id: "1790431664072" }, fast);
    expect(queued()).toEqual([
      { type: "react", arg1: "BIANCHI Luca", arg2: JSON.stringify({ mid: "1790431027228", emoji: "heart" }) },
      { type: "react", arg1: "BIANCHI Luca", arg2: JSON.stringify({ mid: "1790431027228", pill: "👍" }) },
      { type: "edit", arg1: "BIANCHI Luca", arg2: JSON.stringify({ mid: "1790431664072", text: "Done ✅" }) },
      { type: "delete", arg1: "BIANCHI Luca", arg2: JSON.stringify({ mid: "1790431664072" }) },
      { type: "undodelete", arg1: "BIANCHI Luca", arg2: JSON.stringify({ mid: "1790431664072" }) },
    ]);
  });

  it("refuses an empty edit", async () => {
    await expect(editMessage("u1", { chat: "BIANCHI Luca", message_id: "1790431664072", text: " " }, fast)).rejects.toThrow(/Empty text/);
  });
});

describe("get_attachment", () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it("shows a saved image and a SharePoint file downloaded with the Teams session", async () => {
    const media = path.join(dataDir, String(mine), "media");
    fs.mkdirSync(media, { recursive: true });
    fs.writeFileSync(path.join(media, "00112233445566aa.png"), PNG);
    db.prepare("UPDATE chat_messages SET extra=? WHERE mid='1790431027228'").run(
      JSON.stringify({ images: [{ f: "00112233445566aa.png" }], files: [{ name: "data.csv", url: "https://contoso.sharepoint.com/sites/x/data.csv" }] }),
    );
    stop = fakeAgent();
    const [summary, image, file] = await getAttachment("u1", { chat: "BIANCHI Luca", message_id: "1790431027228" }, fast);
    expect(JSON.parse((summary as { text: string }).text)).toMatchObject({
      account: mine,
      attachments: [
        { index: 1, kind: "image", shown: true },
        { index: 2, kind: "file", name: "data.csv", shown: true },
      ],
    });
    expect(image).toEqual({ type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
    expect(file).toEqual({ type: "text", text: "--- data.csv ---\na,b\n1,2\n" });
    expect(queued()).toEqual([{ type: "download", arg1: "https://contoso.sharepoint.com/sites/x/data.csv", arg2: JSON.stringify({ name: "data.csv" }) }]);
  });

  it("gives one attachment by index, and says what it cannot fetch", async () => {
    db.prepare("UPDATE chat_messages SET extra=? WHERE mid='1790431027228'").run(
      JSON.stringify({ images: [{ url: "https://eu-api.asm.skype.com/v1/objects/x/views/imgo" }], files: [{ name: "a.pdf", url: "https://example.com/a.pdf" }] }),
    );
    const [summary, ...rest] = await getAttachment("u1", { chat: "BIANCHI Luca", message_id: "1790431027228", index: 1 }, fast);
    expect(rest).toEqual([]);
    expect(JSON.parse((summary as { text: string }).text).attachments).toEqual([
      { index: 1, kind: "image", shown: false, note: expect.stringMatching(/refresh_chat/), link: "https://eu-api.asm.skype.com/v1/objects/x/views/imgo" },
    ]);
    const [other] = await getAttachment("u1", { chat: "BIANCHI Luca", message_id: "1790431027228", index: 2 }, fast);
    expect(JSON.parse((other as { text: string }).text).attachments[0]).toMatchObject({ kind: "file", shown: false, note: expect.stringMatching(/SharePoint/) });
    await expect(getAttachment("u1", { chat: "BIANCHI Luca", message_id: "1790431027228", index: 3 }, fast)).rejects.toThrow(/out of range/);
    await expect(getAttachment("u1", { chat: "BIANCHI Luca", message_id: "nope" }, fast)).rejects.toThrow(/read_chat/);
    await expect(getAttachment("u1", { chat: "BIANCHI Luca", message_id: "temp-1" }, fast)).rejects.toThrow(/no image or file/);
    expect(queued()).toEqual([]);
  });
});
