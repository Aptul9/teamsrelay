import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as members } from "@/app/api/members/route";
import { POST as send } from "@/app/api/send/route";
import { appDb, claimSlot, migrateAppSchema, setSlotStopped } from "@/lib/appdb";
import { HttpError } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import { membersKey } from "@/shared/slot-db/state";
import { createSlotDb, tempDir } from "./helpers";

// The session is better-auth's: here it resolves to the slot of the test, or refuses like for another user's slot
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
});

const post = (handler: typeof send, body: unknown) =>
  handler(new Request(`http://localhost:8090/api/x?a=${slot}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), undefined);
const commands = () => slotDb.prepare("SELECT type, arg1, arg2 FROM commands ORDER BY id").all() as { type: string; arg1: string; arg2: string }[];
const saveMembers = (chat: string, ts: number, names: string[]) =>
  slotDb.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)").run(membersKey(chat), JSON.stringify({ ts, names }));
const now = () => Math.floor(Date.now() / 1000);

describe("POST /api/send with people tagged", () => {
  it("queues the message in parts when it tags someone", async () => {
    const r = await post(send, { name: "Cloud team", text: "Hi @ROSSI Anna, can you check?", mentions: ["ROSSI Anna"] });
    expect(r.status).toBe(200);
    expect(commands()).toEqual([
      { type: "sendmentions", arg1: "Cloud team", arg2: JSON.stringify({ parts: [{ text: "Hi " }, { mention: "ROSSI Anna" }, { text: ", can you check?" }] }) },
    ]);
  });

  it("queues a plain message without people, or when their @name is gone from the text", async () => {
    await post(send, { name: "Cloud team", text: "Hi all" });
    await post(send, { name: "Cloud team", text: "Hi all again", mentions: ["ROSSI Anna"] });
    expect(commands()).toEqual([
      { type: "send", arg1: "Cloud team", arg2: "Hi all" },
      { type: "send", arg1: "Cloud team", arg2: "Hi all again" },
    ]);
  });

  it("refuses people that are not a short list of names: 400", async () => {
    for (const mentions of ["ROSSI Anna", [42], [""], ["x".repeat(101)], ["a\nb"], Array.from({ length: 21 }, (_, i) => `P${i}`)]) {
      expect((await post(send, { name: "Cloud team", text: "Hi @P1", mentions })).status, JSON.stringify(mentions).slice(0, 30)).toBe(400);
    }
    expect(commands()).toEqual([]);
  });
});

describe("POST /api/members", () => {
  it("answers with the names read within the hour, without asking the agent", async () => {
    saveMembers("Cloud team", now() - 600, ["ROSSI Anna", "BIANCHI Luca"]);
    const r = await post(members, { name: "Cloud team" });
    expect(await r.json()).toEqual({ names: ["ROSSI Anna", "BIANCHI Luca"] });
    expect(commands()).toEqual([]);
  });

  it("asks the agent once when the names are older than an hour, and answers with them meanwhile", async () => {
    saveMembers("Cloud team", now() - 7200, ["ROSSI Anna"]);
    const first = await (await post(members, { name: "Cloud team" })).json();
    const second = await (await post(members, { name: "Cloud team" })).json();
    expect(first).toEqual({ names: ["ROSSI Anna"], id: expect.any(Number) });
    expect(second.id).toBe(first.id);
    expect(commands()).toEqual([{ type: "members", arg1: "Cloud team", arg2: "" }]);
  });

  it("leaves you out: Teams never lists you among the people to tag", async () => {
    slotDb.prepare("INSERT OR REPLACE INTO state(k, v) VALUES('me', ?)").run(JSON.stringify({ name: "MARITATO Antonio", email: "", tenant: "", av: "" }));
    saveMembers("Cloud team", now(), ["ROSSI Anna", "MARITATO Antonio"]);
    expect(await (await post(members, { name: "Cloud team" })).json()).toEqual({ names: ["ROSSI Anna"] });
  });

  it("asks the agent for a chat never read", async () => {
    expect(await (await post(members, { name: "Anna Rossi" })).json()).toEqual({ names: [], id: expect.any(Number) });
  });

  it("gives the last names of a stopped account without a command", async () => {
    setSlotStopped(appDb(), slot, true);
    saveMembers("Cloud team", 1, ["ROSSI Anna"]);
    expect(await (await post(members, { name: "Cloud team" })).json()).toEqual({ names: ["ROSSI Anna"] });
    expect(commands()).toEqual([]);
  });

  it("refuses the slot of another user: 404", async () => {
    vi.mocked(requireSlot).mockRejectedValueOnce(new HttpError(404, "Account not found"));
    expect((await post(members, { name: "Cloud team" })).status).toBe(404);
  });
});
