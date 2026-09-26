import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { isSlotStopped, listSlots, migrateAppSchema, openAppDb, slotOwner } from "@/lib/appdb";
import type { DockerClient } from "@/lib/docker";
import { HttpError } from "@/lib/http";
import { addAccount, exclusive, keepSlotsUp, removeAccount, setAccountRunning, wipeSlot } from "@/lib/slots";
import { tempDir } from "./helpers";

let db: Database.Database;
let dataDir: string;
let wipeDir: string;
let calls: string[];

// wait records the wipe requests present while the wipe container runs
function docker(failStart?: string, wipeExit = 0): DockerClient {
  return {
    async start(name) {
      calls.push(`start ${name}`);
      if (name === failStart) throw new HttpError(502, `Docker: start ${name} failed`);
    },
    async stop(name) {
      calls.push(`stop ${name}`);
    },
    async wait(name) {
      calls.push(`wait ${name} [${fs.readdirSync(wipeDir).join(",")}]`);
      return wipeExit;
    },
  };
}

beforeEach(() => {
  const root = tempDir();
  dataDir = path.join(root, "data");
  wipeDir = path.join(root, "wipe");
  db = openAppDb(path.join(dataDir, "app.db"));
  migrateAppSchema(db);
  calls = [];
});

const opts = () => ({ db, dataDir, wipeDir, slotCount: 4, perUser: 4 });

function oldData(n: number) {
  fs.mkdirSync(path.join(dataDir, String(n)), { recursive: true });
  fs.writeFileSync(path.join(dataDir, String(n), "messages.db"), "old data");
}

describe("addAccount", () => {
  it("starts from a clean slot: stop, wipe, then browser before agent", async () => {
    oldData(1);

    const slot = await addAccount("u1", docker(), opts());

    expect(slot).toBe(1);
    expect(calls).toEqual([
      "stop teams-agent-1",
      "stop teams-chromium-1",
      "start teams-wipe-1",
      "wait teams-wipe-1 [1]",
      "start teams-chromium-1",
      "start teams-agent-1",
    ]);
    expect(fs.existsSync(path.join(dataDir, "1"))).toBe(false);
    expect(fs.readdirSync(wipeDir)).toEqual([]);
    expect(listSlots(db)).toEqual([{ slot: 1, owner_id: "u1", added: expect.any(Number), stopped: 0, started: 0 }]);
  });

  it("releases the slot when Docker cannot start it", async () => {
    await expect(addAccount("u1", docker("teams-agent-1"), opts())).rejects.toThrow(/start teams-agent-1 failed/);
    expect(listSlots(db)).toEqual([]);
  });

  it("does not start a slot whose wipe failed, and releases it", async () => {
    oldData(1);

    await expect(addAccount("u1", docker(undefined, 1), opts())).rejects.toThrow(/Wipe of slot 1 failed \(exit code 1\)/);

    expect(calls).not.toContain("start teams-chromium-1");
    expect(fs.existsSync(path.join(dataDir, "1", "messages.db"))).toBe(true);
    expect(fs.readdirSync(wipeDir)).toEqual([]);
    expect(listSlots(db)).toEqual([]);
  });
});

describe("removeAccount", () => {
  it("stops agent then browser, wipes the slot and frees it", async () => {
    await addAccount("u1", docker(), opts());
    fs.mkdirSync(path.join(dataDir, "1", "media"), { recursive: true });
    calls = [];

    await removeAccount(1, docker(), opts());

    expect(calls).toEqual(["stop teams-agent-1", "stop teams-chromium-1", "start teams-wipe-1", "wait teams-wipe-1 [1]"]);
    expect(fs.existsSync(path.join(dataDir, "1"))).toBe(false);
    expect(listSlots(db)).toEqual([]);
  });

  it("keeps the account when the wipe failed", async () => {
    await addAccount("u1", docker(), opts());
    oldData(1);

    await expect(removeAccount(1, docker(undefined, 1), opts())).rejects.toThrow(/Wipe of slot 1 failed/);

    expect(fs.existsSync(path.join(dataDir, "1", "messages.db"))).toBe(true);
    expect(listSlots(db)).toEqual([{ slot: 1, owner_id: "u1", added: expect.any(Number), stopped: 0, started: 0 }]);
  });
});

describe("wipeSlot", () => {
  it("withdraws the request when the wipe container cannot be started", async () => {
    await expect(wipeSlot(docker("teams-wipe-2"), 2, { dataDir, wipeDir })).rejects.toThrow(/start teams-wipe-2 failed/);
    expect(fs.readdirSync(wipeDir)).toEqual([]);
  });
});

describe("setAccountRunning", () => {
  it("stops agent then browser and keeps the account; starts browser then agent", async () => {
    await addAccount("u1", docker(), opts());
    oldData(1);
    calls = [];

    await setAccountRunning(1, false, docker(), db);
    expect(calls).toEqual(["stop teams-agent-1", "stop teams-chromium-1"]);
    expect(isSlotStopped(db, 1)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "1", "messages.db"))).toBe(true);
    expect(slotOwner(db, 1)).toBe("u1");

    calls = [];
    await setAccountRunning(1, true, docker(), db);
    expect(calls).toEqual(["start teams-chromium-1", "start teams-agent-1"]);
    expect(isSlotStopped(db, 1)).toBe(false);
  });

  it("stays stopped when Docker cannot start it", async () => {
    await addAccount("u1", docker(), opts());
    await setAccountRunning(1, false, docker(), db);

    await expect(setAccountRunning(1, true, docker("teams-chromium-1"), db)).rejects.toThrow(/start teams-chromium-1 failed/);
    expect(isSlotStopped(db, 1)).toBe(true);
  });

  it("refuses an account removed while the request waited", async () => {
    await expect(setAccountRunning(3, true, docker(), db)).rejects.toThrow(/Account not found/);
    expect(calls).toEqual([]);
  });
});

describe("keepSlotsUp", () => {
  it("starts the owned slots except the stopped ones", async () => {
    await addAccount("u1", docker(), opts());
    await addAccount("u1", docker(), opts());
    await setAccountRunning(2, false, docker(), db);
    calls = [];

    const timer = keepSlotsUp(docker(), db, 3_600_000);
    await exclusive(async () => undefined);
    clearInterval(timer);

    expect(calls).toEqual(["start teams-chromium-1", "start teams-agent-1"]);
  });
});
