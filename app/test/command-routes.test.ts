import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as del } from "@/app/api/delete/route";
import { POST as edit } from "@/app/api/edit/route";
import { POST as open } from "@/app/api/open/route";
import { POST as react } from "@/app/api/react/route";
import { POST as reply } from "@/app/api/reply/route";
import { POST as undodelete } from "@/app/api/undodelete/route";
import { appDb, claimSlot, migrateAppSchema, setSlotStopped } from "@/lib/appdb";
import { requireSlot } from "@/lib/session";
import { STATE } from "@/shared/slot-db/state";
import { createSlotDb, tempDir } from "./helpers";

// The routes of the commands made of what the app sends alone: the chat as `name`, the rest checked like the API of
// the local relay checks it (src/shared/command-input.ts)
vi.mock("@/lib/session", () => ({ requireSlot: vi.fn() }));

let slot: number;
let slotDb: ReturnType<typeof createSlotDb>;

beforeAll(() => {
  const dataDir = tempDir();
  process.env.APP_DB = path.join(dataDir, "app.db");
  migrateAppSchema(appDb());
  slot = claimSlot(appDb(), "u1", { perUser: 4 });
  slotDb = createSlotDb(path.join(dataDir, String(slot), "messages.db"));
});

beforeEach(() => {
  vi.mocked(requireSlot).mockResolvedValue({ user: { id: "u1", email: "u1@contoso.example", name: "U1" }, slot });
  setSlotStopped(appDb(), slot, false);
  slotDb.exec("DELETE FROM commands; DELETE FROM state");
  // an agent that wrote its health just now takes commands
  slotDb.prepare("INSERT INTO state(k, v) VALUES(?, ?)").run(STATE.health, JSON.stringify({ ts: Date.now() / 1000, overall: "green" }));
});

const post = (handler: typeof del, body: unknown) =>
  handler(new Request(`http://localhost:8090/api/x?a=${slot}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), undefined);
const commands = () => slotDb.prepare("SELECT type, arg1, arg2 FROM commands ORDER BY id").all();

describe("routes of the commands of a message", () => {
  it("queue each command with the chat and its arguments as the agent reads them", async () => {
    for (const [handler, body] of [
      [open, { name: "Anna Rossi" }],
      [reply, { name: "Anna Rossi", mid: "m1", text: "sure" }],
      [edit, { name: "Anna Rossi", mid: "m2", text: "fixed" }],
      [del, { name: "Anna Rossi", mid: "m2" }],
      [undodelete, { name: "Anna Rossi", mid: "m2" }],
      [react, { name: "Anna Rossi", mid: "m1", emoji: "like" }],
      [react, { name: "Anna Rossi", mid: "m1", pill: "👍" }],
    ] as const) {
      const r = await post(handler, body);
      expect(r.status, JSON.stringify(body)).toBe(200);
      expect(await r.json()).toMatchObject({ ok: true, id: expect.any(Number) });
    }
    expect(commands()).toEqual([
      { type: "open", arg1: "Anna Rossi", arg2: "" },
      { type: "reply", arg1: "Anna Rossi", arg2: JSON.stringify({ mid: "m1", text: "sure" }) },
      { type: "edit", arg1: "Anna Rossi", arg2: JSON.stringify({ mid: "m2", text: "fixed" }) },
      { type: "delete", arg1: "Anna Rossi", arg2: JSON.stringify({ mid: "m2" }) },
      { type: "undodelete", arg1: "Anna Rossi", arg2: JSON.stringify({ mid: "m2" }) },
      { type: "react", arg1: "Anna Rossi", arg2: JSON.stringify({ mid: "m1", emoji: "like" }) },
      { type: "react", arg1: "Anna Rossi", arg2: JSON.stringify({ mid: "m1", pill: "👍" }) },
    ]);
  });

  it("refuse a missing chat, message id, text or reaction with 400, and queue nothing", async () => {
    for (const [handler, body] of [
      [open, {}],
      [reply, { name: "Anna Rossi", text: "sure" }],
      [edit, { name: "Anna Rossi", mid: "m2", text: " " }],
      [del, { mid: "m2" }],
      [react, { name: "Anna Rossi", mid: "m1", emoji: "rocket" }],
    ] as const) {
      expect((await post(handler, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(commands()).toEqual([]);
  });

  it("refuse with 409 while the account is stopped", async () => {
    setSlotStopped(appDb(), slot, true);
    expect((await post(del, { name: "Anna Rossi", mid: "m2" })).status).toBe(409);
    expect(commands()).toEqual([]);
  });
});
