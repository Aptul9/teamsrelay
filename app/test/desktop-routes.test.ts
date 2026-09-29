import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as authcheck } from "@/app/api/authcheck/route";
import { GET as desktop } from "@/app/api/desktop/[slot]/route";
import { appDb, claimSlot, migrateAppSchema, setRelayToken } from "@/lib/appdb";
import { controlClient } from "@/lib/control";
import { currentUser } from "@/lib/session";
import { createSlotDb, tempDir } from "./helpers";

// better-auth's session and the supervisor are stand-ins here
vi.mock("@/lib/session", () => ({ currentUser: vi.fn() }));
vi.mock("@/lib/control", () => ({ controlClient: vi.fn() }));

const u1 = { id: "u1", email: "u1@contoso.example", name: "U1" };
const u2 = { id: "u2", email: "u2@contoso.example", name: "U2" };
const admin = { id: "a1", email: "admin@contoso.example", name: "Admin", role: "admin" };
let slot: number;
let shown: number[];
let showFails: boolean;

beforeAll(() => {
  process.env.APP_DB = path.join(tempDir(), "app.db");
  migrateAppSchema(appDb());
  slot = claimSlot(appDb(), "u1", { slotCount: 4, perUser: 4 });
});

beforeEach(() => {
  shown = [];
  showFails = false;
  vi.mocked(controlClient).mockReturnValue({
    start: async () => undefined,
    stop: async () => undefined,
    wipe: async () => undefined,
    show: async (n) => {
      if (showFails) throw new Error("Browsers container not reachable");
      shown.push(n);
      return true;
    },
  });
});

const open = (n: number | string) => desktop(new Request(`http://localhost:8090/api/desktop/${n}`), { params: Promise.resolve({ slot: String(n) }) });
const check = (uri: string) => authcheck(new Request("http://webapp:8090/api/authcheck", { headers: { "X-Forwarded-Uri": uri } }), undefined);

describe("GET /api/desktop/N", () => {
  it("brings the window of the account to the front and opens the desktop", async () => {
    vi.mocked(currentUser).mockResolvedValue(u1);

    const r = await open(slot);

    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/desktop/");
    expect(shown).toEqual([slot]);
  });

  // its agent then leaves Teams to the owner for a while: no chat switch, no presence keeper
  it("marks the account in use in its database, for its owner only", async () => {
    const db = createSlotDb(path.join(path.dirname(process.env.APP_DB!), String(slot), "messages.db"));
    const desktopRow = () => db.prepare("SELECT v FROM state WHERE k='desktop'").pluck().get() as string | undefined;
    vi.mocked(currentUser).mockResolvedValue(u2);
    expect((await open(slot)).status).toBe(404);
    expect(desktopRow()).toBeUndefined();
    vi.mocked(currentUser).mockResolvedValue(u1);
    const before = Math.floor(Date.now() / 1000);
    expect((await open(slot)).status).toBe(302);
    expect(JSON.parse(desktopRow()!).ts).toBeGreaterThanOrEqual(before);
    db.close();
  });

  it("opens the desktop even when the window could not be brought forward", async () => {
    vi.mocked(currentUser).mockResolvedValue(u1);
    showFails = true;

    expect((await open(slot)).headers.get("Location")).toBe("/desktop/");
  });

  it("answers 404 for an account of someone else, administrators included", async () => {
    for (const user of [u2, admin]) {
      vi.mocked(currentUser).mockResolvedValue(user);
      expect((await open(slot)).status).toBe(404);
    }
    expect((await open("x")).status).toBe(404);
    expect(shown).toEqual([]);
  });

  it("sends a visitor without a session to the login first", async () => {
    vi.mocked(currentUser).mockResolvedValue(null);

    const r = await open(slot);

    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe(`/login?next=${encodeURIComponent(`/api/desktop/${slot}`)}`);
  });
});

describe("GET /api/authcheck", () => {
  it("lets users with a Teams account reach the desktop", async () => {
    vi.mocked(currentUser).mockResolvedValue(u1);
    expect((await check("/desktop/websocket")).status).toBe(200);
  });

  it("refuses users without an account", async () => {
    vi.mocked(currentUser).mockResolvedValue(u2);
    expect((await check("/desktop/")).status).toBe(403);
  });

  it("refuses users whose accounts all run on another computer: the desktop shows none of their windows", async () => {
    const u3 = { id: "u3", email: "u3@contoso.example", name: "U3" };
    setRelayToken(appDb(), claimSlot(appDb(), "u3", { slotCount: 4, perUser: 4 }), "0".repeat(64));
    vi.mocked(currentUser).mockResolvedValue(u3);
    expect((await check("/desktop/")).status).toBe(403);

    // one account in the browsers container is enough
    claimSlot(appDb(), "u3", { slotCount: 4, perUser: 4 });
    expect((await check("/desktop/")).status).toBe(200);
  });

  it("sends a visitor without a session to the login, then back to the desktop", async () => {
    vi.mocked(currentUser).mockResolvedValue(null);

    const r = await check("/desktop/");

    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe(`/login?next=${encodeURIComponent("/desktop/")}`);
  });
});
