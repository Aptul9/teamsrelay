import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureSlotSchema } from "@/shared/slot-db/schema";

export function tempDir(prefix = "teamsrelay-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Slot database with the schema the agent creates
export function createSlotDb(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  ensureSlotSchema(db);
  return db;
}
