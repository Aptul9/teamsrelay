import path from "node:path";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { claimSlot, listSlots, migrateAppSchema, openAppDb, setCheckEvery, setLight, setSlotStopped, slotRow, type Slot } from "@/lib/appdb";
import { SIGNED_OUT, type SlotPort } from "@/lib/checks";
import type { ControlClient } from "@/lib/control";
import { MIN_LIFE, REFRESH_WAIT, refreshDue, runRefresh } from "@/lib/light";
import { accountStatus, statusText } from "@/lib/client";
import { keepSlotsUp, setCheckMode, setLightMode } from "@/lib/slots";
import type { LightSignIn } from "@/shared/slot-db/state";
import { tempDir } from "./helpers";

const T0 = 1_790_000_000;
let db: Database.Database;
let clock: number;
let calls: string[];
let sign: LightSignIn | null;
let health: { ts: number; teams: string } | null;
let onSleep: (secs: number) => void;

const secs = () => Math.floor(clock / 1000);
const sleep = async (ms: number) => {
  clock += ms;
  onSleep(secs());
  await new Promise((r) => setImmediate(r));
};

const ctl: ControlClient = {
  start: async (n) => void calls.push(`start ${n}`),
  light: async (n) => void calls.push(`light ${n}`),
  stop: async (n) => void calls.push(`stop ${n}`),
  wipe: async () => undefined,
  show: async () => true,
};

const port: SlotPort = {
  health: () => health,
  signInAlert: () => ({ armed: true, alerted: false }),
  enqueue: () => 1,
  commandStatus: () => null,
  lightSignIn: () => sign,
};

const deps = () => ({ ctl, db, slot: port, now: () => clock, sleep });

beforeEach(() => {
  db = openAppDb(path.join(tempDir(), "app.db"));
  migrateAppSchema(db);
  clock = T0 * 1000;
  calls = [];
  sign = null;
  health = null;
  onSleep = () => undefined;
});

const slot = (light = true) => {
  const n = claimSlot(db, "u1", { perUser: null });
  if (light) setLight(db, n, true);
  return n;
};

describe("when a light account needs its browser", () => {
  const row = (s: Partial<Slot>): Slot => ({ ...slotRow(db, slot())!, ...s });

  it("before its first sign-in, once it ended or was refused, not while it holds", () => {
    expect(refreshDue(row({}), null, T0)).toBe(true);
    expect(refreshDue(row({}), { at: T0 - 100, expiresOn: T0 + 3600, refused: false }, T0)).toBe(false);
    expect(refreshDue(row({}), { at: T0 - 100, expiresOn: T0 + 30, refused: false }, T0)).toBe(true);
    expect(refreshDue(row({}), { at: T0 - 100, expiresOn: T0 + 3600, refused: true }, T0)).toBe(true);
  });

  it("never for an account stopped, not light, running it now, or tried a moment ago", () => {
    expect(refreshDue(row({ stopped: 1 }), null, T0)).toBe(false);
    expect(refreshDue(row({ light: 0 }), null, T0)).toBe(false);
    expect(refreshDue(row({ refreshing: T0 - 10 }), null, T0)).toBe(false);
    expect(refreshDue(row({ refreshed: T0 - 60, refresh_result: "failed" }), null, T0)).toBe(false);
    expect(refreshDue(row({ refreshed: T0 - 3600, refresh_result: "failed" }), null, T0)).toBe(true);
    expect(refreshDue(row({ refreshed: T0 - 60, refresh_result: "ok" }), { at: 1, expiresOn: 2, refused: true }, T0)).toBe(false);
  });
});

describe("sign-in run of a light account", () => {
  it("runs the browser until it captured a sign-in that holds, then the light agent", async () => {
    const n = slot();
    onSleep = (s) => {
      expect(slotRow(db, n)!.refreshing).toBe(T0);
      if (s >= T0 + 40) sign = { at: s, expiresOn: s + 86_000, refused: false };
    };
    expect(await runRefresh(n, deps())).toBe("ok");
    expect(calls).toEqual([`start ${n}`, `light ${n}`]);
    expect(slotRow(db, n)).toMatchObject({ refreshing: 0, refresh_result: "ok", refreshed: T0 + 40 });
  });

  it("waits for Teams to renew a sign-in that is about to end", async () => {
    const n = slot();
    sign = { at: T0 - 86_000, expiresOn: T0 + MIN_LIFE - 1, refused: false };
    onSleep = (s) => {
      if (s >= T0 + 90) sign = { at: s, expiresOn: s + 86_000, refused: false };
    };
    expect(await runRefresh(n, deps())).toBe("ok");
    expect(secs()).toBe(T0 + 90);
  });

  it("ends as login when Teams stays signed out, as failed when nothing comes; the light agent runs again", async () => {
    const n = slot();
    onSleep = (s) => void (health = { ts: s, teams: "login" });
    expect(await runRefresh(n, deps())).toBe("login");
    expect(secs() - T0).toBeLessThanOrEqual(SIGNED_OUT + 4);
    expect(calls.at(-1)).toBe(`light ${n}`);
    health = null;
    onSleep = () => undefined;
    calls = [];
    const m = slot();
    expect(await runRefresh(m, deps())).toBe("failed");
    expect(calls).toEqual([`start ${m}`, `light ${m}`]);
    expect(slotRow(db, m)).toMatchObject({ refreshing: 0, refresh_result: "failed" });
    expect(secs() - T0).toBeGreaterThanOrEqual(REFRESH_WAIT);
  });

  it("leaves an account set to another mode meanwhile as its owner wants it", async () => {
    const n = slot();
    onSleep = (s) => {
      if (s >= T0 + 10) setLight(db, n, false);
    };
    expect(await runRefresh(n, deps())).toBeNull();
    expect(calls).toEqual([`start ${n}`]);
  });
});

describe("light mode of an account", () => {
  it("keeps the browser of an account always on until the sign-in run, starts the light agent of a stopped or checked one", async () => {
    const on = slot(false);
    await setLightMode(on, ctl, db);
    expect(calls).toEqual([]);
    expect(slotRow(db, on)).toMatchObject({ light: 1, check_every: 0 });

    const stopped = slot(false);
    setSlotStopped(db, stopped, true);
    await setLightMode(stopped, ctl, db);
    const checked = slot(false);
    setCheckEvery(db, checked, 3600, T0);
    await setLightMode(checked, ctl, db);
    expect(calls).toEqual([`light ${stopped}`, `light ${checked}`]);
    expect(slotRow(db, stopped)).toMatchObject({ light: 1, stopped: 0 });
    expect(slotRow(db, checked)).toMatchObject({ light: 1, check_every: 0 });
  });

  it("ends with another mode", async () => {
    const n = slot();
    await setCheckMode(n, 0, ctl, db);
    expect(calls).toEqual([`start ${n}`]);
    expect(slotRow(db, n)!.light).toBe(0);
  });

  it("is kept up as its light agent, not while its browser runs to sign in", async () => {
    const a = slot();
    const b = slot();
    db.prepare("UPDATE teams_accounts SET refreshing=? WHERE slot=?").run(T0, b);
    const c = slot(false);
    clearInterval(keepSlotsUp(ctl, db, 1_000_000));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([`light ${a}`, `start ${c}`]);
    expect(listSlots(db).map((s) => s.light)).toEqual([1, 1, 0]);
  });

  it("shows as always on without browser in the app", () => {
    const a = { stopped: false, checkEvery: 0, checking: false, nextCheck: 0, light: true, refreshing: false };
    expect(accountStatus(a)).toBe("light");
    expect(statusText(a)).toBe("Active, no browser");
    expect(statusText({ ...a, refreshing: true })).toBe("Signing in again");
    expect(statusText({ ...a, teams: "login" })).toBe("Signed out");
  });
});
