// The server side of an account on another computer (src/lib/relay.ts, src/lib/slots.ts): its token, what the web
// app no longer asks the supervisor, what a sync may write, the wait for commands, the files the relay uploads.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import { accountSummary } from "@/lib/accounts";
import { appDb, claimSlot, listSlots, migrateAppSchema, slotRow, slotsOf } from "@/lib/appdb";
import { queue } from "@/lib/commands";
import type { ControlClient } from "@/lib/control";
import { HttpError } from "@/lib/http";
import { applySync, missingRelayFiles, requireRelay, saveRelayFile, waitForRelayCommands } from "@/lib/relay";
import { addRelayAccount, keepSlotsUp, removeAccount, renewRelayToken, setAccountRunning, setCheckMode } from "@/lib/slots";
import { STATE } from "@/shared/slot-db/state";
import { tempDir } from "./helpers";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let dataDir: string;
const calls: string[] = [];
const ctl: ControlClient = {
  start: async (n) => void calls.push(`start ${n}`),
  stop: async (n) => void calls.push(`stop ${n}`),
  wipe: async (n) => void calls.push(`wipe ${n}`),
  show: async (n) => (calls.push(`show ${n}`), true),
};
const opts = () => ({ db: appDb(), dataDir, slotCount: 50, perUser: 6 });
const bearer = (token: string, extra: Record<string, string> = {}) => new Request("http://localhost:8090/api/relay/sync", { headers: { Authorization: `Bearer ${token}`, ...extra } });
const slotDb = (n: number) => new Database(path.join(dataDir, String(n), "messages.db"), { fileMustExist: true });
const stream = (data: Buffer | string) => new Response(typeof data === "string" ? data : new Uint8Array(data)).body;

beforeAll(() => {
  dataDir = tempDir();
  process.env.APP_DB = path.join(dataDir, "app.db");
  migrateAppSchema(appDb());
});

describe("an account on another computer", () => {
  it("gets a slot, an empty database of the slot schema and a token kept only as a digest", async () => {
    const { slot, token } = await addRelayAccount("u1", opts());
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(slotRow(appDb(), slot)).toMatchObject({ owner_id: "u1", relay: 1, stopped: 0, check_every: 0 });
    const stored = appDb().prepare("SELECT relay_token FROM teams_accounts WHERE slot=?").pluck().get(slot);
    expect(stored).toBe(crypto.createHash("sha256").update(token).digest("hex"));
    const db = slotDb(slot);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all()).toEqual(
      expect.arrayContaining(["activity", "calls", "chat_messages", "chats", "commands", "readby", "state"]),
    );
    db.close();
    expect(calls).toEqual([]);
  });

  it("is reached with its token only, never from a web page", async () => {
    const { slot, token } = await addRelayAccount("u2", opts());
    expect(requireRelay(bearer(token))).toMatchObject({ slot });
    const refusal = (req: Request) => {
      try {
        requireRelay(req);
      } catch (e) {
        return e instanceof HttpError ? e.status : "other";
      }
      return "taken";
    };
    expect(refusal(bearer("x".repeat(43)))).toBe(401);
    expect(refusal(new Request("http://localhost:8090/api/relay/sync"))).toBe(401);
    expect(refusal(bearer(""))).toBe(401);
    expect(refusal(bearer(token, { Origin: "https://evil.example" }))).toBe(403);
  });

  it("is never started, stopped or checked through the supervisor", async () => {
    const { slot } = await addRelayAccount("u3", opts());
    const container = claimSlot(appDb(), "u3", { slotCount: 50, perUser: 6 });
    calls.length = 0;
    clearInterval(keepSlotsUp(ctl, appDb(), 3_600_000));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toContain(`start ${container}`);
    expect(calls).not.toContain(`start ${slot}`);
    await expect(setAccountRunning(slot, false, ctl, appDb())).rejects.toMatchObject({ status: 409 });
    await expect(setCheckMode(slot, 3600, ctl, appDb())).rejects.toMatchObject({ status: 409 });
    expect(calls.filter((c) => c.endsWith(` ${slot}`))).toEqual([]);
  });

  it("gets a new token that replaces the old one at once; an account of the server has none", async () => {
    const { slot, token } = await addRelayAccount("u4", opts());
    const fresh = await renewRelayToken(slot, appDb());
    expect(fresh).not.toBe(token);
    expect(() => requireRelay(bearer(token))).toThrow(HttpError);
    expect(requireRelay(bearer(fresh)).slot).toBe(slot);
    const container = claimSlot(appDb(), "u4", { slotCount: 50, perUser: 6 });
    await expect(renewRelayToken(container, appDb())).rejects.toMatchObject({ status: 409 });
  });

  it("is removed without the supervisor: its data goes, its token stops working", async () => {
    const { slot, token } = await addRelayAccount("u5", opts());
    calls.length = 0;
    await removeAccount(slot, ctl, opts());
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, String(slot)))).toBe(false);
    expect(listSlots(appDb()).some((s) => s.slot === slot)).toBe(false);
    expect(() => requireRelay(bearer(token))).toThrow(HttpError);
  });

  it("takes commands only while its relay syncs", async () => {
    const { slot } = await addRelayAccount("q1", opts());
    const health = (ts: number) => JSON.stringify({ cdp: "ok", ts, teams: "ok", overall: "green" });
    expect(() => queue(slot, "resync")).toThrow(/relay of this Teams account is not connected/);
    applySync(slot, { host: "office-pc", state: { [STATE.health]: health(Math.floor(Date.now() / 1000)) } });
    expect(queue(slot, "resync")).toBeGreaterThan(0);
    applySync(slot, { host: "office-pc", state: { [STATE.health]: health(Math.floor(Date.now() / 1000) - 120) } });
    expect(() => queue(slot, "resync")).toThrow(/relay of this Teams account on office-pc is not connected/);
  });

  it("shows where it runs, with no remote desktop", async () => {
    const { slot } = await addRelayAccount("u6", opts());
    applySync(slot, { host: "office-pc", state: { [STATE.me]: JSON.stringify({ name: "Anna Rossi", email: "anna@contoso.example", tenant: "Contoso" }) } }, 1790500000);
    expect(accountSummary(slotsOf(appDb(), "u6").find((s) => s.slot === slot)!)).toMatchObject({
      relay: true,
      host: "office-pc",
      relaySeen: 1790500000,
      name: "Anna Rossi",
      desktop: "",
    });
  });
});

describe("a sync", () => {
  it("keeps the newer viewing, lets the server alone write relay, and sets the status of commands of the server", async () => {
    const { slot } = await addRelayAccount("s1", opts());
    const db = slotDb(slot);
    db.prepare("INSERT INTO state(k, v) VALUES(?, ?)").run(STATE.viewing, JSON.stringify({ chat: "Anna Rossi", ts: 200 }));
    const id = Number(db.prepare("INSERT INTO commands(ts, type, arg1, arg2) VALUES(1, 'send', 'Anna Rossi', 'hi')").run().lastInsertRowid);
    db.close();

    applySync(slot, { host: "pc", state: { [STATE.viewing]: JSON.stringify({ chat: "Old", ts: 100 }), [STATE.relay]: '{"host":"forged"}' }, commands: [{ id, status: "done" }] }, 1000);
    const read = () => {
      const d = slotDb(slot);
      try {
        return {
          viewing: JSON.parse(d.prepare("SELECT v FROM state WHERE k=?").pluck().get(STATE.viewing) as string).chat,
          relay: JSON.parse(d.prepare("SELECT v FROM state WHERE k=?").pluck().get(STATE.relay) as string),
          status: d.prepare("SELECT status FROM commands WHERE id=?").pluck().get(id),
        };
      } finally {
        d.close();
      }
    };
    expect(read()).toEqual({ viewing: "Anna Rossi", relay: { host: "pc", seen: 1000 }, status: "done" });
    applySync(slot, { host: "pc", state: { [STATE.viewing]: JSON.stringify({ chat: "Newer", ts: 300 }) } }, 1001);
    expect(read().viewing).toBe("Newer");
  });

  it("replaces the rows of a chat, and drops them for a chat gone", async () => {
    const { slot } = await addRelayAccount("s2", opts());
    const row = (idx: number, text: string) => ({ idx, mid: String(1790000000000 + idx), author: "A", text, mine: 0, reacts: "", extra: null });
    applySync(slot, { host: "pc", messages: { A: [row(0, "one"), row(1, "two")], B: [row(0, "b")] } });
    applySync(slot, { host: "pc", messages: { A: [row(0, "three")], B: [] } });
    const db = slotDb(slot);
    expect(db.prepare("SELECT chat, text FROM chat_messages ORDER BY chat, idx").all()).toEqual([{ chat: "A", text: "three" }]);
    db.close();
  });
});

describe("the wait for commands", () => {
  it("answers at once with the pending commands after the id given, else after the wait", async () => {
    const { slot } = await addRelayAccount("c1", opts());
    const db = slotDb(slot);
    const insert = db.prepare("INSERT INTO commands(ts, type, arg1, arg2, status) VALUES(?, ?, 'Anna Rossi', '', ?)");
    const first = Number(insert.run(10, "open", "done").lastInsertRowid);
    const second = Number(insert.run(11, "open", "pending").lastInsertRowid);
    db.close();

    expect(await waitForRelayCommands(slot, { after: 0, vts: 0, waitMs: 10_000 })).toEqual({
      commands: [{ id: second, ts: 11, type: "open", arg1: "Anna Rossi", arg2: "" }],
      viewing: null,
    });
    expect(first).toBeLessThan(second);
    const t = Date.now();
    expect(await waitForRelayCommands(slot, { after: second, vts: 0, waitMs: 400 })).toEqual({ commands: [], viewing: null });
    expect(Date.now() - t).toBeGreaterThanOrEqual(350);
  });

  it("wakes up for a command queued meanwhile, and for a newer viewing", async () => {
    const { slot } = await addRelayAccount("c2", opts());
    const waiting = waitForRelayCommands(slot, { after: 0, vts: 50, waitMs: 10_000 });
    setTimeout(() => {
      const db = slotDb(slot);
      db.prepare("INSERT INTO commands(ts, type, arg1, arg2) VALUES(1, 'resync', '', '')").run();
      db.close();
    }, 300);
    expect((await waiting).commands).toHaveLength(1);

    const db = slotDb(slot);
    db.prepare("INSERT INTO state(k, v) VALUES(?, ?)").run(STATE.viewing, JSON.stringify({ chat: "Anna Rossi", ts: 40 }));
    db.close();
    expect((await waitForRelayCommands(slot, { after: 1, vts: 50, waitMs: 300 })).viewing).toBeNull();
    expect((await waitForRelayCommands(slot, { after: 1, vts: 39, waitMs: 300 })).viewing).toEqual({ chat: "Anna Rossi", ts: 40 });
  });
});

describe("the files of a relay", () => {
  it("are asked only by the names of the slot folders, and only when missing", async () => {
    const { slot } = await addRelayAccount("f1", opts());
    fs.mkdirSync(path.join(dataDir, String(slot), "media"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, String(slot), "media", "0123456789abcdef.png"), PNG);
    expect(
      missingRelayFiles(slot, { media: ["0123456789abcdef.png", "1111111111111111.jpg", "../app.db", "x.svg"], files: ["2222222222222222.xlsx", "..%2fapp.db"] }),
    ).toEqual({ media: ["1111111111111111.jpg"], files: ["2222222222222222.xlsx"] });
  });

  it("are written whole, an image only when its bytes are the type its name says", async () => {
    const { slot } = await addRelayAccount("f2", opts());
    const media = path.join(dataDir, String(slot), "media");
    await expect(saveRelayFile(slot, "media", "../../app.db", stream(PNG))).rejects.toMatchObject({ status: 400 });
    await expect(saveRelayFile(slot, "media", "0123456789abcdef.jpg", stream(PNG))).rejects.toMatchObject({ status: 415 });
    await expect(saveRelayFile(slot, "media", "0123456789abcdef.png", stream("<svg onload=alert(1)>"))).rejects.toMatchObject({ status: 415 });
    await expect(saveRelayFile(slot, "media", "0123456789abcdef.png", stream(Buffer.alloc(10e6 + 1, 1)))).rejects.toMatchObject({ status: 413 });
    expect(fs.existsSync(media) ? fs.readdirSync(media) : []).toEqual([]);

    await saveRelayFile(slot, "media", "0123456789abcdef.png", stream(PNG));
    await saveRelayFile(slot, "files", "3333333333333333.pdf", stream("%PDF-1.7"));
    expect(fs.readdirSync(media)).toEqual(["0123456789abcdef.png"]);
    expect(fs.readFileSync(path.join(dataDir, String(slot), "files", "3333333333333333.pdf"), "utf8")).toBe("%PDF-1.7");
  });
});
