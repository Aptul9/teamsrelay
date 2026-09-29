import type Database from "better-sqlite3";

// data/N/messages.db, one per Teams account slot: the agent of the slot creates and writes it, the web app
// reads it and queues commands in it. The Python agent of earlier releases used the same tables, and a slot
// may still run it: columns are added, never renamed or removed.

// The tables as the first release created them
const TABLES = `
  CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, source TEXT, title TEXT, body TEXT);
  CREATE TABLE IF NOT EXISTS chats(name TEXT PRIMARY KEY, preview TEXT, pos INTEGER, ts INTEGER, tm TEXT, unread INTEGER, mention INTEGER);
  CREATE TABLE IF NOT EXISTS chat_messages(chat TEXT, idx INTEGER, mid TEXT, author TEXT, text TEXT, mine INTEGER, reacts TEXT, extra TEXT);
  CREATE TABLE IF NOT EXISTS commands(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, arg1 TEXT, arg2 TEXT, status TEXT DEFAULT 'pending');
  CREATE TABLE IF NOT EXISTS state(k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS readby(mid TEXT PRIMARY KEY, chat TEXT, label TEXT, names TEXT, ts INTEGER);
  CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY, pos INTEGER, kind TEXT, actor TEXT, title TEXT, emoji TEXT, preview TEXT, tm TEXT, chat TEXT, unread INTEGER, ts INTEGER);
`;

// Tables added later: the calls the agent saw ring (since in ms on the wall clock, seconds it rang), the last
// CALL_LOG_SIZE of them
const ADDED_TABLES = `
  CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY AUTOINCREMENT, since INTEGER, caller TEXT, seconds INTEGER);
`;
export const CALL_LOG_SIZE = 50;

// Columns added later, in the order they were added: an old database ends up with the same layout as a new one
const ADDED_COLUMNS = [
  ["chats", "muted", "INTEGER DEFAULT 0"],
  ["chats", "av", "TEXT"],
  ["chat_messages", "extra", "TEXT"],
  ["activity", "channel", "INTEGER"],
  ["activity", "av", "TEXT"],
  ["commands", "key", "TEXT"],
  // the presence of the person of a 1:1 chat as the list shows it (shared/presence), "" otherwise
  ["chats", "presence", "TEXT"],
] as const;

export const SLOT_TABLES = ["messages", "chats", "chat_messages", "commands", "state", "readby", "activity", "calls"] as const;

// Creates the missing tables and columns. Never drops anything: the web app keeps showing chats and messages
// across restarts of the agent.
export function ensureSlotSchema(db: Database.Database) {
  db.exec(TABLES);
  db.exec(ADDED_TABLES);
  for (const [table, column, decl] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
  // one command per key; commands without one, as the web app queues them, are not concerned
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS commands_key ON commands(key) WHERE key IS NOT NULL");
}
