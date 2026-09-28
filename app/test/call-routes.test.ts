// Answer and hang-up asked from the app: queued for the agent of the account, once per call, only while the call
// rings or is in progress, only for an account of the browsers container.
import path from "node:path";
import type Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as answer } from "@/app/api/call/answer/route";
import { POST as hangup } from "@/app/api/call/hangup/route";
import { appDb, claimSlot, migrateAppSchema, setCheckEvery, setRelayToken, setSlotStopped } from "@/lib/appdb";
import { HttpError } from "@/lib/http";
import { ON_ANOTHER_COMPUTER } from "@/lib/relay";
import { requireSlot } from "@/lib/session";
import { CALL_FRESH_FOR, STATE } from "@/shared/slot-db/state";
import { createSlotDb, tempDir } from "./helpers";

// The session is better-auth's: here it resolves to the slot of the test, or refuses like for another user's slot
vi.mock("@/lib/session", () => ({ requireSlot: vi.fn() }));

const user = { id: "u1", email: "u1@contoso.example", name: "U1" };
let slot: number;
let relaySlot: number;
let slotDb: Database.Database;

beforeAll(() => {
  const dataDir = tempDir();
  process.env.APP_DB = path.join(dataDir, "app.db");
  migrateAppSchema(appDb());
  slot = claimSlot(appDb(), "u1", { slotCount: 4, perUser: 4 });
  relaySlot = claimSlot(appDb(), "u1", { slotCount: 4, perUser: 4 });
  setRelayToken(appDb(), relaySlot, "0".repeat(64));
  slotDb = createSlotDb(path.join(dataDir, String(slot), "messages.db"));
});

beforeEach(() => {
  vi.mocked(requireSlot).mockResolvedValue({ user, slot, added: 0 });
  setSlotStopped(appDb(), slot, false);
  setCheckEvery(appDb(), slot, 0, 0);
  slotDb.exec("DELETE FROM commands; DELETE FROM state");
});

const write = (k: string, v: object) => slotDb.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)").run(k, JSON.stringify(v));
// the call as the agent keeps it: ringing now, or in progress
const ring = (since: number, o: { seen?: number; ringing?: boolean } = {}) => write(STATE.call, { caller: "Anna Rossi", since, seen: o.seen ?? Date.now(), ringing: o.ringing ?? true });
const talk = (since: number, o: { seen?: number; active?: boolean } = {}) => write(STATE.inCall, { caller: "Anna Rossi", since, seen: o.seen ?? Date.now(), active: o.active ?? true });
const post = (handler: typeof answer, body: unknown) =>
  handler(new Request(`http://localhost:8090/api/call/x?a=${slot}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), undefined);
const commands = () => slotDb.prepare("SELECT type, arg1, arg2 FROM commands ORDER BY id").all();
// the agent took every command queued so far and it failed
const failAll = () => slotDb.exec("UPDATE commands SET status='failed'");
const detail = async (r: Response) => ((await r.json()) as { detail?: string }).detail;

describe("POST /api/call/answer", () => {
  it("queues the answer of the call ringing now, once for two taps, and names the desktop to open", async () => {
    const since = Date.now() - 3000;
    ring(since);
    const first = await post(answer, { since });
    const second = await post(answer, { since });
    expect(first.status).toBe(200);
    const [a, b] = [await first.json(), await second.json()];
    expect(a).toEqual({ ok: true, id: expect.any(Number), desktop: `/api/desktop/${slot}` });
    expect(b.id).toBe(a.id);
    expect(commands()).toEqual([{ type: "answer", arg1: "Anna Rossi", arg2: JSON.stringify({ since }) }]);
  });

  it("queues a new answer once the one before ended, for a try again", async () => {
    const since = Date.now() - 3000;
    ring(since);
    const first = await (await post(answer, { since })).json();
    failAll();
    const again = await (await post(answer, { since })).json();
    expect(again.id).not.toBe(first.id);
    expect(commands()).toHaveLength(2);
  });

  it("refuses a call that no longer rings, another call, or none at all: 409, nothing queued", async () => {
    const since = Date.now() - 3000;
    const refused = async () => {
      const r = await post(answer, { since });
      expect(r.status).toBe(409);
      expect(await detail(r)).toBe("Call no longer ringing");
    };
    await refused();
    ring(since - 60_000);
    await refused();
    ring(since, { ringing: false });
    await refused();
    ring(since, { seen: Date.now() - CALL_FRESH_FOR * 1000 - 1000 });
    await refused();
    expect(commands()).toEqual([]);
  });

  it("refuses an account on another computer, a stopped one and one only checked every few hours: 409", async () => {
    const since = Date.now() - 3000;
    ring(since);
    vi.mocked(requireSlot).mockResolvedValueOnce({ user, slot: relaySlot, added: 0 });
    const relay = await post(answer, { since });
    expect([relay.status, await detail(relay)]).toEqual([409, ON_ANOTHER_COMPUTER]);
    setSlotStopped(appDb(), slot, true);
    expect((await post(answer, { since })).status).toBe(409);
    setSlotStopped(appDb(), slot, false);
    setCheckEvery(appDb(), slot, 3600, 0);
    expect((await post(answer, { since })).status).toBe(409);
    expect(commands()).toEqual([]);
  });

  it("refuses a request that names no call: 400", async () => {
    ring(Date.now());
    for (const b of [{}, { since: "soon" }, { since: -1 }, { since: 1.5 }]) expect((await post(answer, b)).status, JSON.stringify(b)).toBe(400);
    expect(commands()).toEqual([]);
  });

  it("answers 404 for an account of someone else", async () => {
    vi.mocked(requireSlot).mockRejectedValueOnce(new HttpError(404, "Account not found"));
    expect((await post(answer, { since: 1 })).status).toBe(404);
  });
});

describe("POST /api/call/hangup", () => {
  it("queues the hang-up of the call in progress, once for two taps, again after one that failed", async () => {
    talk(Date.now() - 60_000);
    const first = await post(hangup, {});
    const second = await post(hangup, {});
    expect(first.status).toBe(200);
    const id = (await first.json()).id;
    expect((await second.json()).id).toBe(id);
    expect(commands()).toEqual([{ type: "hangup", arg1: "Anna Rossi", arg2: "" }]);
    failAll();
    expect((await (await post(hangup, {})).json()).id).not.toBe(id);
  });

  it("refuses a hang-up with no call in progress: 409, nothing queued", async () => {
    const since = Date.now() - 60_000;
    const refused = async () => {
      const r = await post(hangup, {});
      expect([r.status, await detail(r)]).toEqual([409, "No call in progress"]);
    };
    await refused();
    talk(since, { active: false });
    await refused();
    talk(since, { seen: Date.now() - CALL_FRESH_FOR * 1000 - 1000 });
    await refused();
    expect(commands()).toEqual([]);
  });

  it("refuses an account on another computer: 409", async () => {
    vi.mocked(requireSlot).mockResolvedValueOnce({ user, slot: relaySlot, added: 0 });
    const r = await post(hangup, {});
    expect([r.status, await detail(r)]).toEqual([409, ON_ANOTHER_COMPUTER]);
  });
});
