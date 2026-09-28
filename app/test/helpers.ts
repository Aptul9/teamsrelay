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

// A body sent in two parts: the first at once, the rest on release(). `reading` resolves once the route has taken the
// first part and waits for the rest: it has checked the token by then.
export function held(first: string | Uint8Array, rest: string | Uint8Array = "") {
  const bytes = (v: string | Uint8Array) => (typeof v === "string" ? new TextEncoder().encode(v) : v);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const reading = new Promise<void>((r) => (started = r));
  let parts = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (parts++ === 0) return c.enqueue(bytes(first));
      started();
      await gate;
      if (rest.length) c.enqueue(bytes(rest));
      c.close();
    },
  });
  return { body, reading, release };
}
