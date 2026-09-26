import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { listSlots, migrateAppSchema, openAppDb } from "@/lib/appdb";
import type { DockerClient } from "@/lib/docker";
import { HttpError } from "@/lib/http";
import { addAccount, removeAccount, wipeSlot } from "@/lib/slots";
import { tempDir } from "./helpers";

let db: Database.Database;
let dataDir: string;
let configDir: string;
let calls: string[];

function docker(failStart?: string): DockerClient {
  return {
    async start(name) {
      calls.push(`start ${name}`);
      if (name === failStart) throw new HttpError(502, `Docker: start ${name} failed`);
    },
    async stop(name) {
      calls.push(`stop ${name}`);
    },
  };
}

beforeEach(() => {
  const root = tempDir();
  dataDir = path.join(root, "data");
  configDir = path.join(root, "config");
  db = openAppDb(path.join(dataDir, "app.db"));
  migrateAppSchema(db);
  calls = [];
});

const opts = () => ({ db, dataDir, configDir, slotCount: 4, perUser: 4 });

describe("addAccount", () => {
  it("starts from a clean slot: stop, wipe, then browser before agent", async () => {
    fs.mkdirSync(path.join(configDir, "1", "Default"), { recursive: true });
    fs.writeFileSync(path.join(configDir, "1", "Default", "Cookies"), "old session");
    fs.mkdirSync(path.join(dataDir, "1"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "1", "messages.db"), "old data");

    const slot = await addAccount("u1", docker(), opts());

    expect(slot).toBe(1);
    expect(calls).toEqual(["stop teams-agent-1", "stop teams-chromium-1", "start teams-chromium-1", "start teams-agent-1"]);
    expect(fs.readdirSync(path.join(configDir, "1"))).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, "1"))).toBe(false);
    expect(listSlots(db)).toEqual([{ slot: 1, owner_id: "u1", added: expect.any(Number) }]);
  });

  it("releases the slot when Docker cannot start it", async () => {
    await expect(addAccount("u1", docker("teams-agent-1"), opts())).rejects.toThrow(/start teams-agent-1 failed/);
    expect(listSlots(db)).toEqual([]);
  });
});

describe("removeAccount", () => {
  it("stops agent then browser, wipes the slot and frees it", async () => {
    await addAccount("u1", docker(), opts());
    fs.mkdirSync(path.join(dataDir, "1", "media"), { recursive: true });
    calls = [];

    await removeAccount(1, docker(), opts());

    expect(calls).toEqual(["stop teams-agent-1", "stop teams-chromium-1"]);
    expect(fs.existsSync(path.join(dataDir, "1"))).toBe(false);
    expect(listSlots(db)).toEqual([]);
  });
});

describe("wipeSlot", () => {
  it("keeps the config directory itself, which is a bind mount of the browser container", () => {
    fs.mkdirSync(path.join(configDir, "2", "a", "b"), { recursive: true });
    wipeSlot(2, { dataDir, configDir });
    expect(fs.existsSync(path.join(configDir, "2"))).toBe(true);
    expect(fs.readdirSync(path.join(configDir, "2"))).toEqual([]);
  });
});
