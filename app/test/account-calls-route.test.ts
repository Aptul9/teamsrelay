// The Calls switch of an account with no browser, from Settings: stored per account, refused for anything not a boolean
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PATCH } from "@/app/api/accounts/[slot]/route";
import { appDb, claimSlot, migrateAppSchema, setLight, slotRow } from "@/lib/appdb";
import { tempDir } from "./helpers";

vi.mock("@/lib/session", () => ({ requireAccount: vi.fn(async (_req: Request, slot: string) => Number(slot)) }));

let slot: number;
beforeAll(() => {
  process.env.APP_DB = path.join(tempDir(), "app.db");
  migrateAppSchema(appDb());
  slot = claimSlot(appDb(), "u1", { perUser: null });
  setLight(appDb(), slot, true);
});

const patch = (body: object) =>
  PATCH(new Request(`http://localhost/api/accounts/${slot}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ slot: String(slot) }),
  });

describe("calls switch of an account", () => {
  it("turns calls off and on again for that account", async () => {
    expect((await patch({ calls: false })).status).toBe(200);
    expect(slotRow(appDb(), slot)?.calls).toBe(0);
    expect((await patch({ calls: true })).status).toBe(200);
    expect(slotRow(appDb(), slot)?.calls).toBe(1);
  });

  it("refuses a value that is not on or off", async () => {
    expect((await patch({ calls: "yes" })).status).toBe(400);
    expect(slotRow(appDb(), slot)?.calls).toBe(1);
  });
});
