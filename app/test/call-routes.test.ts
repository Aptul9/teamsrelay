// Answer, hang-up, mute and call asked from the app: queued for the agent of the account, once per call, only while
// the call rings or is in progress. An account on another computer takes them as well: its relay fetches the command
// and its agent presses Teams there; there is no desktop to open for it.
import path from "node:path";
import type Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as answer } from "@/app/api/call/answer/route";
import { GET as audioSide } from "@/app/api/call/audio/route";
import { POST as hangup } from "@/app/api/call/hangup/route";
import { POST as mute } from "@/app/api/call/mute/route";
import { POST as start } from "@/app/api/call/start/route";
import { appDb, claimSlot, migrateAppSchema, setCheckEvery, setRelayToken, setSlotStopped } from "@/lib/appdb";
import { HttpError } from "@/lib/http";
import { relayDigest } from "@/lib/relay";
import { requireSlot } from "@/lib/session";
import { CALL_FRESH_FOR, STATE } from "@/shared/slot-db/state";
import { createSlotDb, tempDir } from "./helpers";

// The session is better-auth's: here it resolves to the slot of the test, or refuses like for another user's slot
vi.mock("@/lib/session", () => ({ requireSlot: vi.fn() }));

const user = { id: "u1", email: "u1@contoso.example", name: "U1" };
let slot: number;
let relaySlot: number;
let slotDb: Database.Database;
let relayDb: Database.Database;

beforeAll(() => {
  const dataDir = tempDir();
  process.env.APP_DB = path.join(dataDir, "app.db");
  migrateAppSchema(appDb());
  slot = claimSlot(appDb(), "u1", { perUser: 4 });
  relaySlot = claimSlot(appDb(), "u1", { perUser: 4 });
  setRelayToken(appDb(), relaySlot, "0".repeat(64));
  slotDb = createSlotDb(path.join(dataDir, String(slot), "messages.db"));
  relayDb = createSlotDb(path.join(dataDir, String(relaySlot), "messages.db"));
});

beforeEach(() => {
  vi.mocked(requireSlot).mockResolvedValue({ user, slot });
  setSlotStopped(appDb(), slot, false);
  setCheckEvery(appDb(), slot, 0, 0);
  slotDb.exec("DELETE FROM commands; DELETE FROM state");
  relayDb.exec("DELETE FROM commands; DELETE FROM state; DELETE FROM chats");
});

const write = (k: string, v: object, db = slotDb) => db.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)").run(k, JSON.stringify(v));
// the call as the agent keeps it: ringing now, or in progress
const ring = (since: number, o: { seen?: number; ringing?: boolean } = {}, db = slotDb) =>
  write(STATE.call, { caller: "Anna Rossi", since, seen: o.seen ?? Date.now(), ringing: o.ringing ?? true }, db);
const talk = (since: number, o: { seen?: number; active?: boolean } = {}, db = slotDb) =>
  write(STATE.inCall, { caller: "Anna Rossi", since, seen: o.seen ?? Date.now(), active: o.active ?? true }, db);
// the next request comes from the account on another computer, whose relay syncs (commands wait for it)
const asRelay = () => {
  write(STATE.health, { cdp: "ok", ts: Math.floor(Date.now() / 1000), teams: "ok", overall: "green" }, relayDb);
  vi.mocked(requireSlot).mockResolvedValue({ user, slot: relaySlot });
};
const relayCommands = () => relayDb.prepare("SELECT type, arg1, arg2 FROM commands ORDER BY id").all();
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

  it("queues the answer for an account on another computer, which has no desktop to open", async () => {
    const since = Date.now() - 3000;
    ring(since, {}, relayDb);
    asRelay();
    const r = await post(answer, { since });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, id: expect.any(Number), desktop: null });
    expect(relayCommands()).toEqual([{ type: "answer", arg1: "Anna Rossi", arg2: JSON.stringify({ since }) }]);
    expect(commands()).toEqual([]);
  });

  it("refuses a stopped account and one only checked every few hours: 409", async () => {
    const since = Date.now() - 3000;
    ring(since);
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

  it("queues the hang-up for an account on another computer, once for two taps", async () => {
    talk(Date.now() - 60_000, {}, relayDb);
    asRelay();
    const first = await post(hangup, {});
    const second = await post(hangup, {});
    expect(first.status).toBe(200);
    expect((await second.json()).id).toBe((await first.json()).id);
    expect(relayCommands()).toEqual([{ type: "hangup", arg1: "Anna Rossi", arg2: "" }]);
    expect(commands()).toEqual([]);
  });
});

describe("the sound of a call of an account on another computer in the app", () => {
  it("marks the answer for the relay only when the page opened the sound and the account is on another computer", async () => {
    const since = Date.now() - 3000;
    ring(since, {}, relayDb);
    asRelay();
    expect((await post(answer, { since, audio: true })).status).toBe(200);
    expect(relayCommands()).toEqual([{ type: "answer", arg1: "Anna Rossi", arg2: JSON.stringify({ since, audio: true }) }]);
    vi.mocked(requireSlot).mockResolvedValue({ user, slot });
    ring(since);
    expect((await post(answer, { since, audio: true })).status).toBe(200);
    expect(commands()).toEqual([{ type: "answer", arg1: "Anna Rossi", arg2: JSON.stringify({ since }) }]);
  });

  it("answers without the mark when the page did not open the sound (a relay of before, a browser that cannot)", async () => {
    const since = Date.now() - 3000;
    ring(since, {}, relayDb);
    asRelay();
    expect((await post(answer, { since })).status).toBe(200);
    expect(relayCommands()).toEqual([{ type: "answer", arg1: "Anna Rossi", arg2: JSON.stringify({ since }) }]);
  });

  it("marks a call placed from the app on an account on another computer", async () => {
    relayDb.prepare("INSERT OR REPLACE INTO chats(name, preview, pos, ts, tm, unread, mention, muted, av, presence, kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("Anna Rossi", "", 0, 0, "", 0, 0, 0, "", "", "one");
    asRelay();
    expect((await post(start, { name: "Anna Rossi", audio: true })).status).toBe(200);
    expect(relayCommands()).toEqual([{ type: "call", arg1: "Anna Rossi", arg2: JSON.stringify({ audio: true }) }]);
  });

  describe("GET /api/call/audio: who opens the socket", () => {
    const APP = "https://localhost:8090";
    const ask = (headers: Record<string, string>, a = relaySlot) => audioSide(new Request(`http://127.0.0.1:8090/api/call/audio?a=${a}`, { headers }), undefined);

    it("the relay by its token, never from a web page", async () => {
      const token = "t".repeat(43);
      setRelayToken(appDb(), relaySlot, relayDigest(token));
      try {
        const r = await ask({ authorization: `Bearer ${token}` });
        expect([r.status, await r.json()]).toEqual([200, { slot: relaySlot, side: "relay" }]);
        expect((await ask({ authorization: `Bearer ${"x".repeat(43)}` })).status).toBe(401);
        expect((await ask({ authorization: `Bearer ${token}`, origin: APP })).status).toBe(403);
      } finally {
        setRelayToken(appDb(), relaySlot, "0".repeat(64));
      }
    });

    it("the page of the app of the owner, from the site of the app, for an account on another computer", async () => {
      asRelay();
      const r = await ask({ origin: APP });
      expect([r.status, await r.json()]).toEqual([200, { slot: relaySlot, side: "app" }]);
      expect((await ask({ origin: "https://evil.example" })).status).toBe(403);
      expect((await ask({})).status).toBe(403);
      vi.mocked(requireSlot).mockResolvedValue({ user, slot });
      expect((await ask({ origin: APP }, slot)).status).toBe(409);
      vi.mocked(requireSlot).mockRejectedValueOnce(new HttpError(401, "Not signed in"));
      expect((await ask({ origin: APP })).status).toBe(401);
    });
  });
});

describe("POST /api/call/start", () => {
  // the chat list as the agent keeps it, with the kind of each chat
  const chat = (name: string, kind: string) =>
    slotDb.prepare("INSERT OR REPLACE INTO chats(name, preview, pos, ts, tm, unread, mention, muted, av, presence, kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(name, "", 0, 0, "", 0, 0, 0, "", "", kind);
  beforeEach(() => {
    slotDb.exec("DELETE FROM chats");
    chat("Anna Rossi", "one");
    chat("Project Alpha", "group");
    chat("Weekly sync", "meeting");
    chat("MARITATO Antonio (You)", "one");
  });

  it("queues the call of a 1:1 chat, once for two taps, and names the desktop", async () => {
    const first = await post(start, { name: "Anna Rossi" });
    const second = await post(start, { name: "Anna Rossi" });
    expect(first.status).toBe(200);
    const a = await first.json();
    expect(a).toEqual({ ok: true, id: expect.any(Number), desktop: `/api/desktop/${slot}` });
    expect((await second.json()).id).toBe(a.id);
    expect(commands()).toEqual([{ type: "call", arg1: "Anna Rossi", arg2: "" }]);
  });

  it("refuses a group or meeting chat, a chat not in the list and the self chat: 409, nothing queued", async () => {
    for (const name of ["Project Alpha", "Weekly sync", "Nobody Here", "MARITATO Antonio (You)"]) {
      const r = await post(start, { name });
      expect([r.status, await detail(r)], name).toEqual([409, "Only a 1:1 chat can be called"]);
    }
    expect(commands()).toEqual([]);
  });

  it("refuses while a call rings or is in progress on the account: 409, nothing queued", async () => {
    ring(Date.now() - 1000);
    const ringing = await post(start, { name: "Anna Rossi" });
    expect([ringing.status, await detail(ringing)]).toEqual([409, "A call is on: end it first"]);
    slotDb.exec("DELETE FROM state");
    talk(Date.now() - 60_000);
    expect((await post(start, { name: "Anna Rossi" })).status).toBe(409);
    expect(commands()).toEqual([]);
  });

  it("queues the call of a 1:1 chat for an account on another computer, which has no desktop to open", async () => {
    relayDb.prepare("INSERT OR REPLACE INTO chats(name, preview, pos, ts, tm, unread, mention, muted, av, presence, kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("Anna Rossi", "", 0, 0, "", 0, 0, 0, "", "", "one");
    asRelay();
    const r = await post(start, { name: "Anna Rossi" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, id: expect.any(Number), desktop: null });
    expect(relayCommands()).toEqual([{ type: "call", arg1: "Anna Rossi", arg2: "" }]);
    expect(commands()).toEqual([]);
  });

  it("refuses a stopped account and one only checked every few hours: 409", async () => {
    setSlotStopped(appDb(), slot, true);
    expect((await post(start, { name: "Anna Rossi" })).status).toBe(409);
    setSlotStopped(appDb(), slot, false);
    setCheckEvery(appDb(), slot, 3600, 0);
    expect((await post(start, { name: "Anna Rossi" })).status).toBe(409);
    expect(commands()).toEqual([]);
  });

  it("refuses a request that names no chat: 400, and answers 404 for an account of someone else", async () => {
    for (const b of [{}, { name: "" }, { name: 5 }]) expect((await post(start, b)).status, JSON.stringify(b)).toBe(400);
    expect(commands()).toEqual([]);
    vi.mocked(requireSlot).mockRejectedValueOnce(new HttpError(404, "Account not found"));
    expect((await post(start, { name: "Anna Rossi" })).status).toBe(404);
  });
});

describe("POST /api/call/mute", () => {
  it("queues the state asked for the call in progress: once for two taps, again for the other state", async () => {
    talk(Date.now() - 60_000);
    const first = await post(mute, { on: true });
    const second = await post(mute, { on: true });
    expect(first.status).toBe(200);
    const id = (await first.json()).id;
    expect((await second.json()).id).toBe(id);
    const back = await (await post(mute, { on: false })).json();
    expect(back.id).not.toBe(id);
    expect(commands()).toEqual([
      { type: "mute", arg1: "Anna Rossi", arg2: JSON.stringify({ on: true }) },
      { type: "mute", arg1: "Anna Rossi", arg2: JSON.stringify({ on: false }) },
    ]);
  });

  it("refuses a request that asks for no state: 400, nothing queued", async () => {
    talk(Date.now() - 60_000);
    for (const b of [{}, { on: "yes" }, { on: 1 }, { on: null }]) expect((await post(mute, b)).status, JSON.stringify(b)).toBe(400);
    expect(commands()).toEqual([]);
  });

  it("refuses a mute with no call in progress: 409, nothing queued", async () => {
    const since = Date.now() - 60_000;
    const refused = async () => {
      const r = await post(mute, { on: true });
      expect([r.status, await detail(r)]).toEqual([409, "No call in progress"]);
    };
    await refused();
    talk(since, { active: false });
    await refused();
    talk(since, { seen: Date.now() - CALL_FRESH_FOR * 1000 - 1000 });
    await refused();
    expect(commands()).toEqual([]);
  });

  it("queues the mute for an account on another computer", async () => {
    talk(Date.now() - 60_000, {}, relayDb);
    asRelay();
    const r = await post(mute, { on: true });
    expect(r.status).toBe(200);
    expect(relayCommands()).toEqual([{ type: "mute", arg1: "Anna Rossi", arg2: JSON.stringify({ on: true }) }]);
    expect(commands()).toEqual([]);
  });

  it("answers 404 for an account of someone else", async () => {
    vi.mocked(requireSlot).mockRejectedValueOnce(new HttpError(404, "Account not found"));
    expect((await post(mute, { on: true })).status).toBe(404);
  });
});
