import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { accountSummary, healthFor } from "@/lib/accounts";
import { appDb, claimSlot, migrateAppSchema, releaseSlot, setSlotStopped, slotsOf } from "@/lib/appdb";
import { queue } from "@/lib/commands";
import { createSlotDb, tempDir } from "./helpers";

// accounts and commands read data/app.db and data/N through the configuration: one data directory per file
let dataDir: string;
beforeAll(() => {
  dataDir = tempDir();
  process.env.APP_DB = path.join(dataDir, "app.db");
  migrateAppSchema(appDb());
});

const summary = (user: string, n: number) => accountSummary(slotsOf(appDb(), user).find((s) => s.slot === n)!);

describe("a stopped account", () => {
  it("shows grey whatever its agent wrote last, and takes no commands", () => {
    const n = claimSlot(appDb(), "u1", { slotCount: 4, perUser: 4 });
    const slotDb = createSlotDb(path.join(dataDir, String(n), "messages.db"));
    slotDb.prepare("INSERT INTO state(k, v) VALUES('health', ?)").run(JSON.stringify({ ts: Date.now() / 1000, teams: "ok", overall: "green" }));
    expect(summary("u1", n)).toMatchObject({ teams: "ok", overall: "green", stopped: false });
    expect(queue(n, "resync")).toBeGreaterThan(0);

    setSlotStopped(appDb(), n, true);

    expect(summary("u1", n)).toMatchObject({ teams: "stopped", overall: "grey", stopped: true });
    expect(healthFor("u1", n)).toMatchObject({ teams: "stopped", agent: "stopped", overall: "grey" });
    expect(() => queue(n, "resync")).toThrow(/stopped/);
  });

  it("counts as starting again from its start, not from the day it was added", () => {
    const n = claimSlot(appDb(), "u2", { slotCount: 4, perUser: 4 });
    appDb().prepare("UPDATE teams_accounts SET added=? WHERE slot=?").run(Math.floor(Date.now() / 1000) - 86400, n);
    expect(summary("u2", n)).toMatchObject({ teams: "unknown", overall: "red" });

    setSlotStopped(appDb(), n, true);
    setSlotStopped(appDb(), n, false);

    expect(summary("u2", n)).toMatchObject({ teams: "starting", overall: "yellow", stopped: false });
  });
});

describe("the unread counts of an account", () => {
  it("carry the unread chats and, once the agent read the feed, the ids of the unread notifications", () => {
    const n = claimSlot(appDb(), "u3", { slotCount: 4, perUser: 4 });
    expect(summary("u3", n)).toMatchObject({ unread: 0, unreadActivity: null });

    const slotDb = createSlotDb(path.join(dataDir, String(n), "messages.db"));
    slotDb.prepare("INSERT INTO chats(name,preview,pos,ts,tm,unread,mention,muted,av) VALUES('Anna Rossi','hi',0,0,'',1,0,0,'')").run();
    slotDb.prepare("INSERT INTO activity(id,pos,kind,actor,title,emoji,preview,tm,chat,unread,ts,channel,av) VALUES('x1',0,'mention','','','','','','',1,0,0,'')").run();
    expect(summary("u3", n)).toMatchObject({ unread: 1, unreadActivity: null });

    slotDb.prepare("INSERT INTO state(k, v) VALUES('activity_ts', ?)").run(String(Math.floor(Date.now() / 1000)));
    expect(summary("u3", n)).toMatchObject({ unread: 1, unreadActivity: ["x1"] });
  });

  it("carry when the account took its slot, which changes when another account takes the slot", () => {
    const n = claimSlot(appDb(), "u4", { slotCount: 4, perUser: 4 });
    appDb().prepare("UPDATE teams_accounts SET added=? WHERE slot=?").run(1790000000, n);
    expect(summary("u4", n).added).toBe(1790000000);
    releaseSlot(appDb(), n);
    expect(claimSlot(appDb(), "u4", { slotCount: 4, perUser: 4 })).toBe(n);
    expect(summary("u4", n).added).toBeGreaterThan(1790000000);
  });
});
