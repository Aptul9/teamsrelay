import { execFileSync } from "node:child_process";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSlotSchema, SLOT_TABLES } from "@/shared/slot-db/schema";
import { tempDir } from "./helpers";

type Column = { name: string; type: string; dflt_value: string | null; pk: number };

const layout = (db: Database.Database) =>
  Object.fromEntries(
    SLOT_TABLES.map((t) => [
      t,
      (db.prepare(`PRAGMA table_info(${t})`).all() as Column[]).map(
        (c) => `${c.name} ${c.type}${c.pk ? " PK" : ""}${c.dflt_value !== null ? ` = ${c.dflt_value}` : ""}`,
      ),
    ]),
  );

// PRAGMA table_info of data/1/messages.db created by the Python agent (agent.py db_init), local stack 2026-09-26
const PYTHON_LAYOUT = {
  messages: ["id INTEGER PK", "ts INTEGER", "source TEXT", "title TEXT", "body TEXT"],
  chats: ["name TEXT PK", "preview TEXT", "pos INTEGER", "ts INTEGER", "tm TEXT", "unread INTEGER", "mention INTEGER", "muted INTEGER = 0", "av TEXT"],
  chat_messages: ["chat TEXT", "idx INTEGER", "mid TEXT", "author TEXT", "text TEXT", "mine INTEGER", "reacts TEXT", "extra TEXT"],
  commands: ["id INTEGER PK", "ts INTEGER", "type TEXT", "arg1 TEXT", "arg2 TEXT", "status TEXT = 'pending'"],
  state: ["k TEXT PK", "v TEXT"],
  readby: ["mid TEXT PK", "chat TEXT", "label TEXT", "names TEXT", "ts INTEGER"],
  activity: ["id TEXT PK", "pos INTEGER", "kind TEXT", "actor TEXT", "title TEXT", "emoji TEXT", "preview TEXT", "tm TEXT", "chat TEXT", "unread INTEGER", "ts INTEGER", "channel INTEGER", "av TEXT"],
};

// Added by the TypeScript agent: the presence of the person of a chat; the key an app gives a command, queued once per
// key; the calls it saw ring
const LAYOUT = {
  ...PYTHON_LAYOUT,
  chats: [...PYTHON_LAYOUT.chats, "presence TEXT"],
  commands: [...PYTHON_LAYOUT.commands, "key TEXT"],
  calls: ["id INTEGER PK", "since INTEGER", "caller TEXT", "seconds INTEGER"],
};

const fresh = () => new Database(path.join(tempDir(), "messages.db"));

describe("slot database schema", () => {
  it("creates the layout of the Python agent, plus the columns added since", () => {
    const db = fresh();
    ensureSlotSchema(db);
    expect(layout(db)).toEqual(LAYOUT);
  });

  it("keeps one command per key, and any number without one", () => {
    const db = fresh();
    ensureSlotSchema(db);
    const insert = db.prepare("INSERT INTO commands(ts, type, arg1, arg2, key) VALUES(0, 'send', 'Anna Rossi', 'hi', ?)");
    insert.run("k0123456789abcdef");
    expect(() => insert.run("k0123456789abcdef")).toThrow(/UNIQUE/);
    insert.run(null);
    insert.run(null);
    expect(db.prepare("SELECT COUNT(*) FROM commands").pluck().get()).toBe(3);
  });

  it("runs again without touching the rows", () => {
    const db = fresh();
    ensureSlotSchema(db);
    db.prepare("INSERT INTO chats(name, preview, pos, ts, tm, unread, mention) VALUES('Anna Rossi', 'hi', 0, 0, '', 1, 0)").run();
    ensureSlotSchema(db);
    expect(layout(db)).toEqual(LAYOUT);
    expect(db.prepare("SELECT name, unread, muted FROM chats").all()).toEqual([{ name: "Anna Rossi", unread: 1, muted: 0 }]);
  });

  it("adds the later columns to a database of the first release", () => {
    const db = fresh();
    db.exec(`
      CREATE TABLE chats(name TEXT PRIMARY KEY, preview TEXT, pos INTEGER, ts INTEGER, tm TEXT, unread INTEGER, mention INTEGER);
      CREATE TABLE chat_messages(chat TEXT, idx INTEGER, mid TEXT, author TEXT, text TEXT, mine INTEGER, reacts TEXT);
      CREATE TABLE activity(id TEXT PRIMARY KEY, pos INTEGER, kind TEXT, actor TEXT, title TEXT, emoji TEXT, preview TEXT, tm TEXT, chat TEXT, unread INTEGER, ts INTEGER);
      INSERT INTO chats VALUES('Luca Bianchi', 'ciao', 0, 0, '10:30', 0, 0);
    `);
    ensureSlotSchema(db);
    expect(layout(db)).toEqual(LAYOUT);
    expect(db.prepare("SELECT name, muted, av FROM chats").get()).toEqual({ name: "Luca Bianchi", muted: 0, av: null });
  });

  it("matches the database written by the seed script", () => {
    const dir = tempDir();
    execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/seed-slot.mjs"), dir, "3"], { stdio: "pipe" });
    const db = new Database(path.join(dir, "3", "messages.db"), { readonly: true });
    expect(layout(db)).toEqual(LAYOUT);
    db.close();
  });
});
