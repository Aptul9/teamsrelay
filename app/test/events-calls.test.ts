// The event stream of an open app and its calls: a call that starts ringing, or goes on or off, reaches the app within
// a look of CALLS_EVERY_MS, not at the next read of everything else (once a second), so the app rings as soon as the
// agent saw the call, and a tap on Answer or Hang up shows its outcome without waiting a second more.
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CALLS_EVERY_MS, GET } from "@/app/api/events/route";
import { appDb, claimSlot, migrateAppSchema } from "@/lib/appdb";
import { currentUser, requireUser } from "@/lib/session";
import { STATE } from "@/shared/slot-db/state";
import { createSlotDb, tempDir } from "./helpers";

// The session is better-auth's: here it is the user of the test
vi.mock("@/lib/session", () => ({ requireUser: vi.fn(), currentUser: vi.fn() }));

const user = { id: "u1", email: "u1@contoso.example", name: "U1" };
let slot: number;
let slotDb: Database.Database;

beforeAll(() => {
  const dataDir = tempDir();
  process.env.APP_DB = path.join(dataDir, "app.db");
  migrateAppSchema(appDb());
  slot = claimSlot(appDb(), "u1", { slotCount: 4, perUser: 4 });
  slotDb = createSlotDb(path.join(dataDir, String(slot), "messages.db"));
});

beforeEach(() => {
  vi.mocked(requireUser).mockResolvedValue(user as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(currentUser).mockResolvedValue(user as Awaited<ReturnType<typeof currentUser>>);
  slotDb.exec("DELETE FROM state");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => vi.useRealTimers());

const write = (k: string, v: object) => slotDb.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)").run(k, JSON.stringify(v));

// The stream of the app with the account on screen (and a chat: &chat=): the events as they come, by name
async function open(query = "") {
  const stop = new AbortController();
  const res = await GET(new Request(`http://localhost:8090/api/events?a=${slot}${query}`, { signal: stop.signal }), undefined);
  const reader = res.body!.getReader();
  const events: { name: string; data: unknown }[] = [];
  const text = new TextDecoder();
  let buffer = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += text.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const name = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (name) events.push({ name, data: data === undefined ? null : JSON.parse(data) });
      }
    }
  })();
  const last = (name: string) => events.filter((e) => e.name === name).at(-1)?.data;
  const count = (name: string) => events.filter((e) => e.name === name).length;
  return { last, count, close: () => stop.abort() };
}

// The app itself tells which chat it shows (POST /api/viewing, told=1 on its stream): a stream still open while the
// app is gone (a phone that lost the network) keeps no chat open in Teams
describe("chat on screen", () => {
  const viewing = () => slotDb.prepare("SELECT v FROM state WHERE k=?").pluck().get(STATE.viewing) as string | undefined;

  it("is not marked by the stream of an app that tells it itself", async () => {
    const s = await open("&chat=Anna%20Rossi&told=1");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(s.count("messages")).toBeGreaterThan(0);
    expect(viewing()).toBeUndefined();
    s.close();
  });

  // a page loaded before the deploy runs the build before it until reloaded: its chat stays marked as it was
  it("is marked every 10 s by the stream of an app of the build before", async () => {
    const s = await open("&chat=Anna%20Rossi");
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.parse(viewing() ?? "{}").chat).toBe("Anna Rossi");
    s.close();
  });
});

describe("calls on the event stream", () => {
  it("looks at the calls four times a second", () => {
    expect(CALLS_EVERY_MS).toBe(250);
  });

  it("sends a call that starts ringing within one look at the calls, and the same call in progress after an answer", async () => {
    const s = await open();
    await vi.advanceTimersByTimeAsync(10);
    expect(s.last("calls")).toEqual([]);
    const since = Date.now();
    write(STATE.call, { caller: "Anna Rossi", since, seen: since, ringing: true });
    await vi.advanceTimersByTimeAsync(CALLS_EVERY_MS);
    expect(s.last("calls")).toEqual([{ acc: slot, caller: "Anna Rossi", since }]);
    // answered: the agent writes the call as no longer ringing and in progress in one look
    write(STATE.call, { caller: "Anna Rossi", since, seen: Date.now(), ringing: false });
    write(STATE.inCall, { caller: "Anna Rossi", since, seen: Date.now(), active: true });
    await vi.advanceTimersByTimeAsync(CALLS_EVERY_MS);
    expect(s.last("calls")).toEqual([{ acc: slot, caller: "Anna Rossi", since, active: true }]);
    // hung up
    write(STATE.inCall, { caller: "Anna Rossi", since, seen: Date.now(), active: false });
    await vi.advanceTimersByTimeAsync(CALLS_EVERY_MS);
    expect(s.last("calls")).toEqual([]);
    s.close();
  });

  it("sends the calls again only when they change", async () => {
    const s = await open();
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.count("calls")).toBe(1);
    s.close();
  });

  it("stops looking once the app goes", async () => {
    const s = await open();
    await vi.advanceTimersByTimeAsync(10);
    s.close();
    await vi.advanceTimersByTimeAsync(10);
    const since = Date.now();
    write(STATE.call, { caller: "Anna Rossi", since, seen: since, ringing: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.count("calls")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
