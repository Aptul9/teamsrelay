import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

export function tempDir(prefix = "teamsrelay-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Same schema the agent creates in db_init() (agent/agent.py).
export function createSlotDb(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, source TEXT, title TEXT, body TEXT);
    CREATE TABLE chats(name TEXT PRIMARY KEY, preview TEXT, pos INTEGER, ts INTEGER, tm TEXT, unread INTEGER, mention INTEGER, muted INTEGER DEFAULT 0, av TEXT);
    CREATE TABLE chat_messages(chat TEXT, idx INTEGER, mid TEXT, author TEXT, text TEXT, mine INTEGER, reacts TEXT, extra TEXT);
    CREATE TABLE commands(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, arg1 TEXT, arg2 TEXT, status TEXT DEFAULT 'pending');
    CREATE TABLE state(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE readby(mid TEXT PRIMARY KEY, chat TEXT, label TEXT, names TEXT, ts INTEGER);
    CREATE TABLE activity(id TEXT PRIMARY KEY, pos INTEGER, kind TEXT, actor TEXT, title TEXT, emoji TEXT, preview TEXT, tm TEXT, chat TEXT, unread INTEGER, ts INTEGER, channel INTEGER, av TEXT);
  `);
  return db;
}
