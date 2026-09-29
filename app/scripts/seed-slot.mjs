// Fills data/<slot>/messages.db with sample chats, messages and activity, to work on the web app
// without a signed-in Teams. Same schema the agent creates (src/shared/slot-db/schema.ts, checked by
// test/slot-schema.test.ts).
//   node scripts/seed-slot.mjs <data dir> <slot>
// Local stack: docker compose cp app/scripts/seed-slot.mjs webapp:/app/seed-slot.mjs
//              docker compose exec webapp node /app/seed-slot.mjs /data 1
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const [dataDir, slot] = process.argv.slice(2);
if (!dataDir || !/^\d+$/.test(slot ?? "")) {
  console.error("usage: node seed-slot.mjs <data dir> <slot>");
  process.exit(2);
}
const file = path.join(dataDir, slot, "messages.db");
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, source TEXT, title TEXT, body TEXT);
  CREATE TABLE IF NOT EXISTS chats(name TEXT PRIMARY KEY, preview TEXT, pos INTEGER, ts INTEGER, tm TEXT, unread INTEGER, mention INTEGER, muted INTEGER DEFAULT 0, av TEXT, presence TEXT);
  CREATE TABLE IF NOT EXISTS chat_messages(chat TEXT, idx INTEGER, mid TEXT, author TEXT, text TEXT, mine INTEGER, reacts TEXT, extra TEXT);
  CREATE TABLE IF NOT EXISTS commands(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, arg1 TEXT, arg2 TEXT, status TEXT DEFAULT 'pending', key TEXT);
  CREATE UNIQUE INDEX IF NOT EXISTS commands_key ON commands(key) WHERE key IS NOT NULL;
  CREATE TABLE IF NOT EXISTS state(k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS readby(mid TEXT PRIMARY KEY, chat TEXT, label TEXT, names TEXT, ts INTEGER);
  CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY, pos INTEGER, kind TEXT, actor TEXT, title TEXT, emoji TEXT, preview TEXT, tm TEXT, chat TEXT, unread INTEGER, ts INTEGER, channel INTEGER, av TEXT);
  CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY AUTOINCREMENT, since INTEGER, caller TEXT, seconds INTEGER);
`);

const now = Math.floor(Date.now() / 1000);
const chats = [
  ["Luca Bianchini", "See you at noon", "10:32", 1, 0, 0, "busy"],
  ["Luca Bianchi", "Ciao, the report is ready", "10:30", 0, 0, 0, "available"],
  ["Project Alpha", "Anna: @you can you check the deploy?", "9:58", 1, 1, 0, ""],
  ["Release notes", "Bot: build 1.4.2 published", "9/24", 0, 0, 1, ""],
  ["Anna Rossi (You)", "notes to self", "9/20", 0, 0, 0, "away"],
];
const msgs = {
  "Luca Bianchi": [
    ["m1", "Luca Bianchi", "Morning! Did you get the numbers?", 0, { reactions: [{ e: "👍", n: 1, mine: true }] }],
    ["m2", "", "Yes, sending the summary now", 1, { status: "Seen" }],
    ["m3", "Luca Bianchi", "Ciao, the report is ready", 0, {
      html: "Ciao, the report is <b>ready</b>: <a href=\"https://example.com/report\" target=\"_blank\" rel=\"noopener\">link</a>",
      files: [{ name: "Q3 report.pdf", url: "https://contoso.sharepoint.com/sites/x/Q3%20report.pdf" }],
    }],
  ],
  "Project Alpha": [
    ["p1", "Anna Rossi", "Deploy of 1.4.2 done on staging", 0, {}],
    ["p2", "Anna Rossi", "@you can you check the deploy?", 0, { mentionsMe: true, html: "<span class=\"mn me\">you</span> can you check the deploy?" }],
    ["p3", "", "On it", 1, { readby: { label: "Read by 2 of 3", names: ["Anna Rossi", "Marco Neri"] }, edited: true }],
    ["p4", "", "", 1, { deleted: true, html: "" }],
    ["p5", "Marco Neri", "Looks good from here", 0, { quote: { author: "You", text: "On it" }, reactions: [{ e: "❤️", n: 2, mine: false }] }],
  ],
};

db.transaction(() => {
  db.exec("DELETE FROM chats; DELETE FROM chat_messages; DELETE FROM activity; DELETE FROM calls;");
  chats.forEach(([name, preview, tm, unread, mention, muted, presence], i) =>
    db.prepare("INSERT INTO chats(name,preview,pos,ts,tm,unread,mention,muted,av,presence) VALUES(?,?,?,?,?,?,?,?,?,?)").run(name, preview, i, now, tm, unread, mention, muted, "", presence),
  );
  for (const [chat, rows] of Object.entries(msgs)) {
    rows.forEach(([mid, author, text, mine, extra], i) =>
      db.prepare("INSERT INTO chat_messages(chat,idx,mid,author,text,mine,reacts,extra) VALUES(?,?,?,?,?,?,?,?)").run(chat, i, mid, author, text, mine, "", JSON.stringify(extra)),
    );
  }
  [
    ["a1", "reaction", "Luca Bianchi", "Luca Bianchi reacted to your message", "👍", "Yes, sending the summary now", "10:31", "Luca Bianchi", 1],
    ["a2", "mention", "Anna Rossi", "Anna Rossi mentioned you", "", "@you can you check the deploy?", "9:58", "Project Alpha", 1],
    ["a3", "reply", "Marco Neri", "Marco Neri replied to your message", "", "Looks good from here", "9:59", "Project Alpha", 0],
    // Teams shows a missed call as read, new or not
    ["a4", "call", "Luca Bianchi", "Missed call from Luca Bianchi", "", "Teams call", "9:40", "Luca Bianchi", 0],
  ].forEach(([id, kind, actor, title, emoji, preview, tm, chat, unread], i) =>
    db.prepare("INSERT INTO activity(id,pos,kind,actor,title,emoji,preview,tm,chat,unread,ts,channel,av) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, i, kind, actor, title, emoji, preview, tm, chat, unread, now, 0, ""),
  );
  [
    ["Luca Bianchi", now - 3000, 7],
    ["Anna Rossi", now - 90000, 12],
  ].forEach(([caller, at, seconds]) => db.prepare("INSERT INTO calls(since,caller,seconds) VALUES(?,?,?)").run(at * 1000, caller, seconds));
  const set = db.prepare("INSERT OR REPLACE INTO state(k,v) VALUES(?,?)");
  set.run("me", JSON.stringify({ name: "Anna Rossi", email: "anna.rossi@contoso.example", tenant: "Contoso" }));
  set.run("activity_ts", String(now));
})();
db.close();
console.log(`seeded ${file}`);
