// The public API of a status page, GET /api/status/<slug>: no session, 404 for a page that is not there
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as statusRoute from "@/app/api/status/[slug]/route";
import { appDb, migrateAppSchema } from "@/lib/appdb";
import { addStatusPage, listStatusPages, reservedSlugs, statusDb } from "@/lib/status-pages";
import { dayStart } from "@/lib/status-stats";
import { stretchesOf } from "@/shared/status-db";
import { tempDir } from "./helpers";

const ROME = "Europe/Rome";
const H = 3600;
const DAY = 86400;
// 2026-11-04 00:00 in Rome; now is 10:00 that day
const D = dayStart("2026-11-04", ROME);
const NOW = D + 10 * H;

beforeAll(() => {
  process.env.TZ = ROME;
  process.env.APP_DB = path.join(tempDir(), "app.db");
  migrateAppSchema(appDb());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
});

afterAll(() => {
  vi.useRealTimers();
});

const get = (slug: string) => statusRoute.GET(new Request(`http://localhost:8090/api/status/${slug}`), { params: Promise.resolve({ slug }) });
const stretch = (name: string, since: number, until: number, status: "available" | "busy" | "offline") =>
  statusDb().prepare("INSERT INTO presence_log(name, mri, since, until, status) VALUES(?, '8:orgid:x', ?, ?, ?)").run(name, since, until, status);

describe("GET /api/status/<slug>", () => {
  it("is 404 for a page that is not there, with no session asked", async () => {
    expect((await get("nobody")).status).toBe(404);
    expect((await get("Bad Slug!")).status).toBe(404);
  });

  it("answers the status now, the days from the one the page was added, stretches for today and yesterday only", async () => {
    addStatusPage(appDb(), { slug: "kamila", slot: 4, name: "Camilla Marini", added: D - 2 * DAY + 9 * H, ends: 0 });
    stretch("Camilla Marini", D - 2 * DAY + 9 * H, D - 2 * DAY + 12 * H, "available");
    stretch("Camilla Marini", D + 8 * H, D + 10 * H - 60, "busy");
    const r = await get("kamila");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=30");
    const a = await r.json();
    expect(a).toMatchObject({ name: "Camilla Marini", now: { status: "busy", since: D + 8 * H, fresh: true }, ends: 0, updated: D + 10 * H - 60, zone: ROME });
    expect(a.days.map((d: { day: string }) => d.day)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
    const [first, yesterday, today] = a.days;
    expect(first.hours.available).toBe(3);
    expect(first.stretches).toBeUndefined();
    expect(yesterday.stretches).toEqual([]);
    expect(today.stretches).toEqual([[D + 8 * H, NOW, "busy"]]);
    expect(today.byHour).toHaveLength(24);
    expect(Object.keys(today)).toEqual(["day", "hours", "firstOnline", "lastOnline", "longestAvailable", "green", "byHour", "stretches"]);
  });

  it("says when the status is no longer fresh", async () => {
    addStatusPage(appDb(), { slug: "damian", slot: 4, name: "Damiano Bogni", added: D, ends: 0 });
    stretch("Damiano Bogni", D + 9 * H, D + 9 * H, "available");
    const a = await (await get("damian")).json();
    expect(a.now).toEqual({ status: "available", since: D + 9 * H, fresh: false });
  });

  it("is gone with its data 7 days after the end of its challenge", async () => {
    addStatusPage(appDb(), { slug: "ended", slot: 4, name: "Ended Person", added: D - 20 * DAY, ends: D - 7 * DAY });
    addStatusPage(appDb(), { slug: "recent", slot: 4, name: "Recent Person", added: D - 20 * DAY, ends: D - 2 * DAY });
    stretch("Ended Person", D - 10 * DAY, D - 10 * DAY + H, "available");
    stretch("Recent Person", D - 10 * DAY, D - 10 * DAY + H, "available");
    expect((await get("ended")).status).toBe(404);
    expect(listStatusPages(appDb()).map((p) => p.slug)).not.toContain("ended");
    expect(stretchesOf(statusDb(), "Ended Person", 0, NOW)).toEqual([]);
    const recent = await (await get("recent")).json();
    expect(recent.days.at(-1).day).toBe("2026-11-01");
    expect(recent.now.fresh).toBe(false);
  });
});

describe("the slugs of the app", () => {
  it("reserve every top-level entry of src/app and public, and the paths of Caddy", () => {
    const reserved = reservedSlugs();
    for (const s of ["admin", "api", "consent", "files", "healthz", "login", "mcp", "media", "remote", "settings", "static", "sw.js", "manifest.webmanifest", "desktop"]) expect(reserved, s).toContain(s);
    for (const dir of ["src/app", "public"]) for (const e of fs.readdirSync(path.join(__dirname, "..", dir))) expect(reserved, e).toContain(e);
  });
});
