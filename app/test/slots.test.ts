import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { isSlotStopped, listSlots, migrateAppSchema, openAppDb, slotOwner } from "@/lib/appdb";
import type { ControlClient } from "@/lib/control";
import { HttpError } from "@/lib/http";
import { addAccount, exclusive, keepSlotsUp, removeAccount, setAccountRunning, wipeSlot } from "@/lib/slots";
import { tempDir } from "./helpers";

let db: Database.Database;
let dataDir: string;
let calls: string[];

// Stand-in for the supervisor: records the calls, fails the one named
function control(fail?: string): ControlClient {
  const run = async (call: string) => {
    calls.push(call);
    if (call === fail) throw new HttpError(502, `${call} failed`);
  };
  return {
    start: (n) => run(`start ${n}`),
    stop: (n) => run(`stop ${n}`),
    wipe: (n) => run(`wipe ${n}`),
    show: async (n) => {
      await run(`show ${n}`);
      return true;
    },
  };
}

beforeEach(() => {
  dataDir = path.join(tempDir(), "data");
  db = openAppDb(path.join(dataDir, "app.db"));
  migrateAppSchema(db);
  calls = [];
});

const opts = () => ({ db, dataDir, slotCount: 4, perUser: 4 });

function oldData(n: number) {
  fs.mkdirSync(path.join(dataDir, String(n)), { recursive: true });
  fs.writeFileSync(path.join(dataDir, String(n), "messages.db"), "old data");
}

describe("addAccount", () => {
  it("starts from a clean slot: stop, wipe, start", async () => {
    oldData(1);

    const slot = await addAccount("u1", control(), opts());

    expect(slot).toBe(1);
    expect(calls).toEqual(["stop 1", "wipe 1", "start 1"]);
    expect(fs.existsSync(path.join(dataDir, "1"))).toBe(false);
    expect(listSlots(db)).toEqual([{ slot: 1, owner_id: "u1", added: expect.any(Number), stopped: 0, started: 0 }]);
  });

  it("releases the slot when it cannot be started", async () => {
    await expect(addAccount("u1", control("start 1"), opts())).rejects.toThrow(/start 1 failed/);
    expect(listSlots(db)).toEqual([]);
  });

  it("does not start a slot whose wipe failed, and releases it", async () => {
    oldData(1);

    await expect(addAccount("u1", control("wipe 1"), opts())).rejects.toThrow(/wipe 1 failed/);

    expect(calls).not.toContain("start 1");
    expect(fs.existsSync(path.join(dataDir, "1", "messages.db"))).toBe(true);
    expect(listSlots(db)).toEqual([]);
  });
});

describe("removeAccount", () => {
  it("stops the slot, wipes it and frees it", async () => {
    await addAccount("u1", control(), opts());
    fs.mkdirSync(path.join(dataDir, "1", "media"), { recursive: true });
    calls = [];

    await removeAccount(1, control(), opts());

    expect(calls).toEqual(["stop 1", "wipe 1"]);
    expect(fs.existsSync(path.join(dataDir, "1"))).toBe(false);
    expect(listSlots(db)).toEqual([]);
  });

  it("keeps the account and its data when the wipe failed", async () => {
    await addAccount("u1", control(), opts());
    oldData(1);

    await expect(removeAccount(1, control("wipe 1"), opts())).rejects.toThrow(/wipe 1 failed/);

    expect(fs.existsSync(path.join(dataDir, "1", "messages.db"))).toBe(true);
    expect(listSlots(db)).toEqual([{ slot: 1, owner_id: "u1", added: expect.any(Number), stopped: 0, started: 0 }]);
  });
});

describe("wipeSlot", () => {
  it("deletes the data of the slot only after the profile was wiped", async () => {
    oldData(2);
    await expect(wipeSlot(control("wipe 2"), 2, { dataDir })).rejects.toThrow(/wipe 2 failed/);
    expect(fs.existsSync(path.join(dataDir, "2", "messages.db"))).toBe(true);

    await wipeSlot(control(), 2, { dataDir });
    expect(fs.existsSync(path.join(dataDir, "2"))).toBe(false);
  });
});

describe("setAccountRunning", () => {
  it("stops the account and keeps it; starts it again", async () => {
    await addAccount("u1", control(), opts());
    oldData(1);
    calls = [];

    await setAccountRunning(1, false, control(), db);
    expect(calls).toEqual(["stop 1"]);
    expect(isSlotStopped(db, 1)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "1", "messages.db"))).toBe(true);
    expect(slotOwner(db, 1)).toBe("u1");

    calls = [];
    await setAccountRunning(1, true, control(), db);
    expect(calls).toEqual(["start 1"]);
    expect(isSlotStopped(db, 1)).toBe(false);
  });

  it("stays stopped when it cannot be started", async () => {
    await addAccount("u1", control(), opts());
    await setAccountRunning(1, false, control(), db);

    await expect(setAccountRunning(1, true, control("start 1"), db)).rejects.toThrow(/start 1 failed/);
    expect(isSlotStopped(db, 1)).toBe(true);
  });

  it("refuses an account removed while the request waited", async () => {
    await expect(setAccountRunning(3, true, control(), db)).rejects.toThrow(/Account not found/);
    expect(calls).toEqual([]);
  });
});

describe("keepSlotsUp", () => {
  it("starts the owned slots except the stopped ones", async () => {
    await addAccount("u1", control(), opts());
    await addAccount("u1", control(), opts());
    await setAccountRunning(2, false, control(), db);
    calls = [];

    const timer = keepSlotsUp(control(), db, 3_600_000);
    await exclusive(async () => undefined);
    clearInterval(timer);

    expect(calls).toEqual(["start 1"]);
  });
});
