// The calls ringing now in the accounts of a user, as the event stream of the web app sends them: the open app rings
// for every account whose browser runs, the one on screen or not, while its agent keeps seeing the call.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Slot } from "@/lib/appdb";
import { CallReaders } from "@/lib/calls";
import { CALL_FRESH_FOR, STATE } from "@/shared/slot-db/state";
import { createSlotDb, tempDir } from "./helpers";

const NOW = 1_790_000_000_000;
let dir: string;
let readers: CallReaders;

const slot = (n: number, o: Partial<Slot> = {}): Slot => ({
  slot: n,
  owner_id: "u1",
  added: 0,
  stopped: 0,
  started: 0,
  check_every: 0,
  check_due: 0,
  checked: 0,
  check_result: "",
  checking: 0,
  relay: 0,
  ...o,
});

// the call as the agent of slot n keeps it
function keep(n: number, call: object) {
  const db = createSlotDb(path.join(dir, String(n), "messages.db"));
  db.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)").run(STATE.call, JSON.stringify(call));
  db.close();
}

beforeEach(() => {
  dir = tempDir();
  process.env.APP_DB = path.join(dir, "app.db");
  readers = new CallReaders();
});

afterEach(() => readers.close());

describe("calls ringing in the accounts of a user", () => {
  it("lists the call of every running account, the one on screen or not", () => {
    keep(1, { caller: "Anna Rossi", since: NOW - 3000, seen: NOW - 1000, ringing: true });
    keep(2, { caller: "Luca Bianchi", since: NOW - 1000, seen: NOW, ringing: true });
    expect(readers.ringing([slot(1), slot(2)], NOW)).toEqual([
      { acc: 1, caller: "Anna Rossi", since: NOW - 3000 },
      { acc: 2, caller: "Luca Bianchi", since: NOW - 1000 },
    ]);
  });

  it("drops a call that ended, and one its agent stopped seeing (agent down, page away)", () => {
    keep(1, { caller: "Anna Rossi", since: NOW - 9000, seen: NOW - 2000, ringing: false });
    keep(2, { caller: "Luca Bianchi", since: NOW - 30_000, seen: NOW - CALL_FRESH_FOR * 1000 - 1, ringing: true });
    keep(3, { caller: "Marta Verdi", since: NOW - 30_000, seen: NOW - CALL_FRESH_FOR * 1000 + 1, ringing: true });
    expect(readers.ringing([slot(1), slot(2), slot(3)], NOW)).toEqual([{ acc: 3, caller: "Marta Verdi", since: NOW - 30_000 }]);
  });

  it("reads no call where no browser runs: a stopped account, one checked every N hours between two checks", () => {
    for (const n of [1, 2, 3]) keep(n, { caller: "Anna Rossi", since: NOW, seen: NOW, ringing: true });
    const accounts = [slot(1, { stopped: 1 }), slot(2, { check_every: 3600 }), slot(3, { check_every: 3600, checking: NOW / 1000 })];
    expect(readers.ringing(accounts, NOW)).toEqual([{ acc: 3, caller: "Anna Rossi", since: NOW }]);
  });

  it("has no call for an account whose agent has not created its database yet, then sees its calls", () => {
    expect(readers.ringing([slot(4)], NOW)).toEqual([]);
    keep(4, { caller: "", since: NOW, seen: NOW, ringing: true });
    expect(readers.ringing([slot(4)], NOW)).toEqual([{ acc: 4, caller: "", since: NOW }]);
  });

  it("lists a call in progress too, marked active, until the agent says it is over or stops seeing it", () => {
    keep(1, { caller: "Anna Rossi", since: NOW - 3000, seen: NOW, ringing: true });
    const talk = (n: number, row: object) => {
      const db = createSlotDb(path.join(dir, String(n), "messages.db"));
      db.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)").run(STATE.inCall, JSON.stringify(row));
      db.close();
    };
    talk(2, { caller: "Luca Bianchi", since: NOW - 60_000, seen: NOW - 1000, active: true });
    talk(3, { caller: "Marta Verdi", since: NOW - 60_000, seen: NOW - 1000, active: false });
    talk(4, { caller: "Paolo Neri", since: NOW - 60_000, seen: NOW - CALL_FRESH_FOR * 1000 - 1, active: true });
    expect(readers.ringing([slot(1), slot(2), slot(3), slot(4)], NOW)).toEqual([
      { acc: 1, caller: "Anna Rossi", since: NOW - 3000 },
      { acc: 2, caller: "Luca Bianchi", since: NOW - 60_000, active: true },
    ]);
  });

  it("carries Teams' mute state of a call in progress when the agent could read it", () => {
    const talk = (n: number, row: object) => {
      const db = createSlotDb(path.join(dir, String(n), "messages.db"));
      db.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)").run(STATE.inCall, JSON.stringify(row));
      db.close();
    };
    talk(1, { caller: "Anna Rossi", since: NOW - 60_000, seen: NOW - 1000, active: true, muted: true });
    talk(2, { caller: "Luca Bianchi", since: NOW - 60_000, seen: NOW - 1000, active: true });
    expect(readers.ringing([slot(1), slot(2)], NOW)).toEqual([
      { acc: 1, caller: "Anna Rossi", since: NOW - 60_000, active: true, muted: true },
      { acc: 2, caller: "Luca Bianchi", since: NOW - 60_000, active: true },
    ]);
  });

  it("reads what the agent writes next, and nothing from a broken row", () => {
    keep(1, { caller: "Anna Rossi", since: NOW, seen: NOW, ringing: true });
    expect(readers.ringing([slot(1)], NOW)).toHaveLength(1);
    keep(1, { caller: "Anna Rossi", since: NOW, seen: NOW + 2000, ringing: false });
    expect(readers.ringing([slot(1)], NOW + 2000)).toEqual([]);
    const db = createSlotDb(path.join(dir, "1", "messages.db"));
    db.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)").run(STATE.call, "{broken");
    db.close();
    expect(readers.ringing([slot(1)], NOW)).toEqual([]);
  });
});
