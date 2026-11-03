// The admin card of the status pages, /api/admin/status-pages: administrators only, reserved and taken paths refused,
// a delete takes the data with it
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as adminRoute from "@/app/api/admin/status-pages/route";
import { appDb, claimSlot, migrateAppSchema, setLight } from "@/lib/appdb";
import { HttpError } from "@/lib/http";
import { requireAdmin } from "@/lib/session";
import { statusDb } from "@/lib/status-pages";
import { dayStart } from "@/lib/status-stats";
import { STATE } from "@/shared/slot-db/state";
import { recordStatuses, stretchesOf } from "@/shared/status-db";
import { createSlotDb, tempDir } from "./helpers";

vi.mock("@/lib/session", () => ({ requireAdmin: vi.fn() }));
const asAdmin = () => vi.mocked(requireAdmin).mockResolvedValue({ id: "admin", email: "admin@contoso.example", name: "Admin", role: "admin" });

let dataDir: string;
let light: number;
let always: number;

beforeAll(() => {
  process.env.TZ = "Europe/Rome";
  dataDir = tempDir();
  process.env.APP_DB = path.join(dataDir, "app.db");
  migrateAppSchema(appDb());
  light = claimSlot(appDb(), "admin", { perUser: 9 });
  setLight(appDb(), light, true);
  always = claimSlot(appDb(), "admin", { perUser: 9 });
  const db = createSlotDb(path.join(dataDir, String(light), "messages.db"));
  db.prepare("INSERT INTO state(k, v) VALUES(?, ?)").run(STATE.me, JSON.stringify({ name: "Owner Agap", email: "", tenant: "AGAP2", av: "", logo: "" }));
});

const req = (method: string, body?: unknown) =>
  new Request("http://localhost:8090/api/admin/status-pages", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown) => {
  const r = await adminRoute[method](req(method, body), undefined);
  return { status: r.status, body: await r.json() };
};
const names = (value: Record<string, string>) => {
  const db = createSlotDb(path.join(dataDir, String(light), "messages.db"));
  db.prepare("INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)").run(STATE.statusNames, JSON.stringify(value));
  db.close();
};

describe("/api/admin/status-pages", () => {
  it("is for administrators only", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new HttpError(403, "Administrators only"));
    for (const m of ["GET", "POST", "PATCH", "DELETE"] as const) expect((await call(m, m === "GET" ? undefined : {})).status, m).toBe(403);
  });

  it("refuses a path of the app, a path taken, a bad path and an account that is not light", async () => {
    asAdmin();
    expect(await call("POST", { slug: "admin", slot: light, name: "Camilla Marini" })).toEqual({ status: 409, body: { detail: "/admin is a page of TeamsRelay" } });
    expect((await call("POST", { slug: "desktop", slot: light, name: "Camilla Marini" })).status).toBe(409);
    expect((await call("POST", { slug: "Kamila!", slot: light, name: "Camilla Marini" })).status).toBe(400);
    expect((await call("POST", { slug: "kamila", slot: always, name: "Camilla Marini" })).status).toBe(400);
    expect((await call("POST", { slug: "kamila", slot: light, name: " " })).status).toBe(400);
    expect((await call("POST", { slug: "kamila", slot: light, name: "Camilla Marini" })).status).toBe(200);
    expect(await call("POST", { slug: "kamila", slot: light, name: "Camilla Marini" })).toEqual({ status: 409, body: { detail: "/kamila is already a status page" } });
  });

  it("lists the pages with whether they collect, why not, and the last status seen; the accounts to pick from", async () => {
    asAdmin();
    await call("POST", { slug: "damian", slot: light, name: "Damiano Bogni" });
    let list = (await call("GET")).body;
    expect(list.accounts).toEqual([
      { slot: light, label: "Owner Agap (AGAP2)", light: true },
      { slot: always, label: `Account ${always}`, light: false },
    ]);
    expect(list.pages.find((p: { slug: string }) => p.slug === "damian")).toMatchObject({ slot: light, name: "Damiano Bogni", tenant: "AGAP2", collecting: false, reason: "waiting for the agent", last: null });
    names({ "Damiano Bogni": "" });
    list = (await call("GET")).body;
    expect(list.pages.find((p: { slug: string }) => p.slug === "damian")).toMatchObject({ collecting: false, reason: "not found in AGAP2" });
    names({ "Damiano Bogni": "8:orgid:dam" });
    recordStatuses(statusDb(), [{ name: "Damiano Bogni", mri: "8:orgid:dam", status: "busy" }], 1_793_700_000, 180);
    list = (await call("GET")).body;
    expect(list.pages.find((p: { slug: string }) => p.slug === "damian")).toMatchObject({ collecting: true, reason: "", last: { status: "busy", since: 1_793_700_000, until: 1_793_700_000 } });
  });

  it("says an account set back to always on collects nothing", async () => {
    asAdmin();
    setLight(appDb(), light, false);
    const list = (await call("GET")).body;
    expect(list.pages.find((p: { slug: string }) => p.slug === "damian")).toMatchObject({ collecting: false, reason: "account not light" });
    setLight(appDb(), light, true);
  });

  it("sets the end of the challenge to the end of a day, and clears it", async () => {
    asAdmin();
    expect((await call("PATCH", { slug: "kamila", ends: "2026-11-30" })).status).toBe(200);
    const page = () => (appDb().prepare("SELECT ends FROM status_pages WHERE slug='kamila'").pluck().get() as number);
    expect(page()).toBe(dayStart("2026-12-01", "Europe/Rome"));
    expect((await call("PATCH", { slug: "kamila", ends: "30/11/2026" })).status).toBe(400);
    expect((await call("PATCH", { slug: "nobody", ends: "" })).status).toBe(404);
    expect((await call("PATCH", { slug: "kamila", ends: "" })).status).toBe(200);
    expect(page()).toBe(0);
  });

  it("deletes a page with its data", async () => {
    asAdmin();
    expect((await call("DELETE", { slug: "damian" })).status).toBe(200);
    expect(stretchesOf(statusDb(), "Damiano Bogni", 0, 2e9)).toEqual([]);
    expect((await call("GET")).body.pages.map((p: { slug: string }) => p.slug)).toEqual(["kamila"]);
    expect((await call("DELETE", { slug: "damian" })).status).toBe(404);
  });
});
