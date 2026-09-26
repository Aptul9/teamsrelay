import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { SlotNotReady, SlotReader } from "@/lib/slotdb";
import { createSlotDb, tempDir } from "./helpers";

let file: string;
let raw: Database.Database;

beforeEach(() => {
  file = path.join(tempDir(), "1", "messages.db");
  raw = createSlotDb(file);
});

describe("SlotReader", () => {
  it("marks the chat on screen for the agent, with the time", () => {
    const r = SlotReader.open(file);
    const before = Math.floor(Date.now() / 1000);
    r.markViewing("Anna Rossi");
    r.markViewing("Luca Bianchi");
    const v = JSON.parse(raw.prepare("SELECT v FROM state WHERE k='viewing'").pluck().get() as string);
    expect(v.chat).toBe("Luca Bianchi");
    expect(v.ts).toBeGreaterThanOrEqual(before);
    r.close();
  });

  it("refuses a slot whose agent has not created the database yet", () => {
    expect(() => SlotReader.open(path.join(tempDir(), "9", "messages.db"))).toThrow(SlotNotReady);
  });

  it("reads chats in list order", () => {
    raw.prepare("INSERT INTO chats(name,preview,pos,ts,tm,unread,mention,muted,av) VALUES(?,?,?,?,?,?,?,?,?)").run("B", "hi", 1, 0, "10:00", 0, 0, 0, "");
    raw.prepare("INSERT INTO chats(name,preview,pos,ts,tm,unread,mention,muted,av) VALUES(?,?,?,?,?,?,?,?,?)").run("A", "yo", 0, 0, "10:01", 1, 0, 1, "f.png");
    const r = SlotReader.open(file);
    expect(r.chats()).toEqual([
      { name: "A", preview: "yo", tm: "10:01", unread: 1, mention: 0, muted: 1, av: "f.png" },
      { name: "B", preview: "hi", tm: "10:00", unread: 0, mention: 0, muted: 0, av: "" },
    ]);
    r.close();
  });

  it("merges the extra JSON of messages into each row", () => {
    const ins = raw.prepare("INSERT INTO chat_messages(chat,idx,mid,author,text,mine,reacts,extra) VALUES(?,?,?,?,?,?,?,?)");
    ins.run("A", 1, "m2", "Anna", "second", 0, "", JSON.stringify({ edited: true }));
    ins.run("A", 0, "m1", "", "first", 1, "", "");
    ins.run("B", 0, "x", "", "other chat", 1, "", "");
    const r = SlotReader.open(file);
    expect(r.messages("A")).toEqual([
      { mid: "m1", author: "", text: "first", mine: 1, reacts: "" },
      { mid: "m2", author: "Anna", text: "second", mine: 0, reacts: "", edited: true },
    ]);
    r.close();
  });

  it("queues a command and reports its status and result", () => {
    const r = SlotReader.open(file);
    const id = r.enqueue("download", "https://x.sharepoint.com/f", JSON.stringify({ name: "a.pdf" }));
    expect(r.commandStatus(id)).toEqual({ status: "pending", result: null });
    raw.prepare("UPDATE commands SET status='done' WHERE id=?").run(id);
    raw.prepare("INSERT INTO state(k,v) VALUES(?,?)").run(`cmd_result:${id}`, JSON.stringify({ f: "0123456789abcdef.pdf" }));
    expect(r.commandStatus(id)).toEqual({ status: "done", result: { f: "0123456789abcdef.pdf" } });
    expect(r.commandStatus(id + 1)).toBeNull();
    r.close();
  });

  it("reports the command statuses of the agent with the words of its API: pending, done, failed", () => {
    const r = SlotReader.open(file);
    const id = r.enqueue("members", "Cloud team");
    const status = (s: string) => {
      raw.prepare("UPDATE commands SET status=? WHERE id=?").run(s, id);
      return r.commandStatus(id)?.status;
    };
    // on Teams now: still waiting as far as the app knows, and not queued twice
    expect(status("running")).toBe("pending");
    expect(r.pendingCommand("members", "Cloud team")).toBe(id);
    // the agent stopped while it ran, or Teams did not confirm in time: the app shows it as not done
    expect(status("unconfirmed")).toBe("failed");
    expect(r.pendingCommand("members", "Cloud team")).toBe(0);
    r.close();
  });

  it("reports an agent silent for more than a minute as stale", () => {
    const now = Math.floor(Date.now() / 1000);
    raw.prepare("INSERT INTO state(k,v) VALUES('health', ?)").run(JSON.stringify({ ts: now - 120, teams: "ok", overall: "green" }));
    const r = SlotReader.open(file);
    const h = r.health(now - 3600);
    expect(h.agent).toBe("stale");
    expect(h.overall).toBe("red");
    expect(r.health(now - 10).teams).toBe("starting");
    r.close();
  });

  it("counts unread chats like Teams: muted chats and the self chat excluded", () => {
    const ins = raw.prepare("INSERT INTO chats(name,preview,pos,ts,tm,unread,mention,muted,av) VALUES(?,?,?,?,?,?,?,?,?)");
    ins.run("A", "", 0, 0, "", 1, 0, 0, "");
    ins.run("B", "", 1, 0, "", 1, 0, 1, "");
    ins.run("Me (You)", "", 2, 0, "", 1, 0, 0, "");
    const r = SlotReader.open(file);
    expect(r.unreadCount()).toBe(1);
    r.close();
  });
});
