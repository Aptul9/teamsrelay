import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { SlotStore } from "@/agent/store/slot-store";
import { RelayDevices } from "@/local/devices";
import { SLOT_TABLES } from "@/shared/slot-db/schema";
import { tempDir } from "../helpers";

let file: string;
let devices: RelayDevices;

beforeEach(() => {
  file = path.join(tempDir(), "state", "relay.db");
  SlotStore.open(file).close();
  devices = RelayDevices.open(file);
});

describe("devices of the relay", () => {
  it("keep one subscription per device", () => {
    devices.save("https://push.example/1", '{"endpoint":"https://push.example/1"}', "phone");
    devices.save("https://push.example/1", '{"endpoint":"https://push.example/1","v":2}', "phone");
    devices.save("https://push.example/2", '{"endpoint":"https://push.example/2"}', "pc");
    expect(devices.count()).toBe(2);
    expect(devices.targets()[0]).toEqual({ endpoint: "https://push.example/1", sub: '{"endpoint":"https://push.example/1","v":2}' });
    expect(devices.remove("https://push.example/1")).toBe(true);
    expect(devices.remove("https://push.example/1")).toBe(false);
    expect(devices.count()).toBe(1);
  });

  it("live in relay.db next to the tables of a slot database, which the server's slot databases do not get", () => {
    const db = new Database(file, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").pluck().all();
    db.close();
    expect([...tables].sort()).toEqual([...SLOT_TABLES, "push_subscriptions"].sort());
    expect(SLOT_TABLES).not.toContain("push_subscriptions");
  });
});
