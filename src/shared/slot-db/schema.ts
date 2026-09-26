import type Database from "better-sqlite3";

// state/relay.db: the agent creates it and writes chats, messages and state; the API reads them, queues commands
// and keeps the devices that receive the notifications. Same tables as the slot databases of teamsrelay, less
// the Activity feed and "Read by", plus push_subscriptions.
const TABLES = `
  CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, source TEXT, title TEXT, body TEXT);
  CREATE TABLE IF NOT EXISTS chats(name TEXT PRIMARY KEY, preview TEXT, pos INTEGER, ts INTEGER, tm TEXT, unread INTEGER, mention INTEGER, muted INTEGER DEFAULT 0, av TEXT);
  CREATE TABLE IF NOT EXISTS chat_messages(chat TEXT, idx INTEGER, mid TEXT, author TEXT, text TEXT, mine INTEGER, reacts TEXT, extra TEXT);
  CREATE TABLE IF NOT EXISTS commands(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, arg1 TEXT, arg2 TEXT, status TEXT DEFAULT 'pending');
  CREATE TABLE IF NOT EXISTS state(k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL, ua TEXT, ts INTEGER);
`;

export const SLOT_TABLES = ["messages", "chats", "chat_messages", "commands", "state", "push_subscriptions"] as const;

// Creates the missing tables. Never drops anything: the app keeps showing chats and messages across restarts.
export function ensureSlotSchema(db: Database.Database) {
  db.exec(TABLES);
}
