// The chat on screen in the app, told by the app itself: marked while it shows it, forgotten as soon as it stops
// showing it (another tab, the list, the app closed), so the agent takes Teams back to the self chat at once and Teams
// reads nothing that arrives there unseen (user 2026-09-30).
import path from "node:path";
import type Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/viewing/route";
import { appDb, claimSlot, migrateAppSchema } from "@/lib/appdb";
import { requireSlot } from "@/lib/session";
import { STATE } from "@/shared/slot-db/state";
import { createSlotDb, tempDir } from "./helpers";

vi.mock("@/lib/session", () => ({ requireSlot: vi.fn() }));

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
  vi.mocked(requireSlot).mockResolvedValue({ user, slot, added: 0 });
  slotDb.exec("DELETE FROM state");
});

// as navigator.sendBeacon sends it too: a POST with a JSON body
const post = (body: unknown) => POST(new Request(`http://localhost:8090/api/viewing?a=${slot}`, { method: "POST", body: JSON.stringify(body) }), undefined);
const viewing = () => JSON.parse((slotDb.prepare("SELECT v FROM state WHERE k=?").pluck().get(STATE.viewing) as string | undefined) ?? "null");

describe("POST /api/viewing", () => {
  it("marks the chat the app shows, with the time", async () => {
    const before = Math.floor(Date.now() / 1000);
    expect((await post({ chat: "Anna Rossi" })).status).toBe(200);
    expect(viewing()).toEqual({ chat: "Anna Rossi", ts: expect.any(Number) });
    expect(viewing().ts).toBeGreaterThanOrEqual(before);
  });

  it("forgets it once the app says it left it, and keeps a chat the app shows since", async () => {
    await post({ chat: "Anna Rossi" });
    expect((await post({ left: "Anna Rossi" })).status).toBe(200);
    expect(viewing().chat).toBe("");
    await post({ chat: "Luca Bianchi" });
    await post({ left: "Anna Rossi" });
    expect(viewing().chat).toBe("Luca Bianchi");
  });

  it("refuses a body that names no chat", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ chat: "" })).status).toBe(400);
    expect(viewing()).toBeNull();
  });
});
