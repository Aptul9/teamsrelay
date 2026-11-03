// The light agent collects the status of the people its status pages track (app/status-challenge-spec.md, Collector)
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpStatusError, type LightApi, type PersonPresence } from "@/agent/light/api";
import type { Light } from "@/agent/light/context";
import { StatusCollector, type StatusPageRow } from "@/agent/light/status";
import { log } from "@/agent/log";
import { SlotStore } from "@/agent/store/slot-store";
import { parseState, STATE, StatusNames } from "@/shared/slot-db/state";
import { openStatusDb, recordStatuses, stretchesOf } from "@/shared/status-db";
import { tempDir } from "../helpers";

const SLOT = 4;
const CAMILLA = "Camilla Marini";
const DAMIANO = "Damiano Bogni";
const mri = (oid: string) => `8:orgid:${oid}`;
const T0 = 1_793_700_000;
const at = (s: number) => (T0 + s) * 1000;

function setup(pages: StatusPageRow[] | null = [{ slug: "kamila", slot: SLOT, name: CAMILLA, ends: 0 }]) {
  const dir = tempDir();
  const file = path.join(dir, "status.db");
  const store = SlotStore.open(path.join(dir, "4", "messages.db"));
  const answers = new Map<string, PersonPresence>([[mri("cam"), { availability: "Busy", activity: "InACall" }]]);
  const api = { presence: vi.fn(async (mris: readonly string[]) => new Map([...answers].filter(([m]) => mris.includes(m)))) };
  const l = {
    api: api as unknown as LightApi,
    store,
    people: new Map([[mri("cam"), { displayName: "camilla marini", givenName: "Camilla" }]]),
    list: { ids: new Map<string, string>(), names: new Map<string, string>(), members: new Map<string, string[]>() },
  } as unknown as Light;
  const rows = { pages };
  const read = vi.fn(() => rows.pages);
  const c = new StatusCollector({ pages: read, file, slot: SLOT, gap: 180 });
  const db = openStatusDb(file);
  return { l, c, api, answers, db, store, rows, read };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the status collector of a light account", () => {
  it("extends the stretch on the same status, opens one on a change and after a gap", async () => {
    const { l, c, answers, db } = setup();
    await c.poll(l, at(0));
    await c.poll(l, at(60));
    answers.set(mri("cam"), { availability: "Available", activity: "Available" });
    await c.poll(l, at(120));
    await c.poll(l, at(500));
    expect(stretchesOf(db, CAMILLA, 0, T0 + 1000)).toEqual([
      [T0, T0 + 60, "busy"],
      [T0 + 120, T0 + 120, "available"],
      [T0 + 500, T0 + 500, "available"],
    ]);
  });

  it("writes nothing when the presence call fails, and logs it once an hour per kind", async () => {
    const { l, c, api, db } = setup();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    api.presence.mockRejectedValue(new HttpStatusError(401, "presence"));
    await c.poll(l, at(0));
    await c.poll(l, at(60));
    expect(warn.mock.calls.filter(([scope]) => scope === "status")).toHaveLength(1);
    api.presence.mockRejectedValue(new Error("fetch failed"));
    await c.poll(l, at(120));
    expect(warn.mock.calls.filter(([scope]) => scope === "status")).toHaveLength(2);
    api.presence.mockRejectedValue(new HttpStatusError(401, "presence"));
    await c.poll(l, at(3700));
    expect(warn.mock.calls.filter(([scope]) => scope === "status")).toHaveLength(3);
    expect(stretchesOf(db, CAMILLA, 0, T0 + 9999)).toEqual([]);
  });

  it("writes nothing for a person the service did not answer for", async () => {
    const { l, c, answers, db } = setup();
    answers.clear();
    await c.poll(l, at(0));
    expect(stretchesOf(db, CAMILLA, 0, T0 + 9999)).toEqual([]);
  });

  it("polls only the pages of its account that have not ended", async () => {
    const { l, c, api } = setup([
      { slug: "kamila", slot: SLOT, name: CAMILLA, ends: T0 - 1 },
      { slug: "other", slot: 2, name: "Marco Bianchi", ends: 0 },
    ]);
    await c.poll(l, at(0));
    expect(api.presence).not.toHaveBeenCalled();
  });

  it("finds a person by name without case, else as the other member of the 1:1 chat of that name, and tells who it could not", async () => {
    const { l, c, api, store } = setup([
      { slug: "kamila", slot: SLOT, name: CAMILLA, ends: 0 },
      { slug: "damian", slot: SLOT, name: DAMIANO, ends: 0 },
      { slug: "ghost", slot: SLOT, name: "Nobody Here", ends: 0 },
    ]);
    l.list.ids.set("Damiano Bogni", "19:dam@unq.gbl.spaces");
    l.list.members.set("19:dam@unq.gbl.spaces", [mri("dam")]);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    await c.poll(l, at(0));
    await c.poll(l, at(60));
    expect(api.presence).toHaveBeenLastCalledWith([mri("cam"), mri("dam")]);
    expect(parseState(StatusNames, store.getState(STATE.statusNames))).toEqual({ [CAMILLA]: mri("cam"), [DAMIANO]: mri("dam"), "Nobody Here": "" });
    expect(warn.mock.calls.filter(([scope, m]) => scope === "status" && /Nobody Here/.test(String(m)))).toHaveLength(1);
  });

  it("reads the pages at most once a minute", async () => {
    const { l, c, read } = setup();
    await c.poll(l, at(0));
    await c.poll(l, at(30));
    expect(read).toHaveBeenCalledTimes(1);
    await c.poll(l, at(61));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("deletes once an hour the rows of names no page tracks and of pages ended over 7 days ago", async () => {
    const day = 86400;
    const { l, c, db, rows } = setup([
      { slug: "kamila", slot: SLOT, name: CAMILLA, ends: 0 },
      { slug: "old", slot: SLOT, name: "Ended Long Ago", ends: T0 - 8 * day },
      { slug: "recent", slot: 2, name: "Ended Recently", ends: T0 - 2 * day },
    ]);
    for (const name of ["Ended Long Ago", "Ended Recently", "Gone Page"]) recordStatuses(db, [{ name, mri: "x", status: "away" }], T0 - 9 * day, 180);
    await c.poll(l, at(0));
    const names = () => (db.prepare("SELECT DISTINCT name FROM presence_log ORDER BY name").pluck().all() as string[]);
    expect(names()).toEqual([CAMILLA, "Ended Recently"]);
    rows.pages = [];
    await c.poll(l, at(120));
    expect(names()).toEqual([CAMILLA, "Ended Recently"]);
    await c.poll(l, at(3700));
    expect(names()).toEqual([]);
  });

  it("deletes nothing while app.db cannot be read", async () => {
    const { l, c, db } = setup(null);
    recordStatuses(db, [{ name: CAMILLA, mri: "x", status: "away" }], T0 - 100, 180);
    await c.poll(l, at(0));
    expect(stretchesOf(db, CAMILLA, 0, T0 + 1)).toHaveLength(1);
  });
});
