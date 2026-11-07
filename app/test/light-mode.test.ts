import path from "node:path";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { askRefresh, claimSlot, endRefresh, listSlots, migrateAppSchema, openAppDb, setCheckEvery, setLight, setSlotStopped, slotRow, type Slot } from "@/lib/appdb";
import { SIGN_IN_WAIT, SIGNED_OUT, type SlotPort } from "@/lib/checks";
import type { ControlClient } from "@/lib/control";
import { BROWSER_WAIT, browserOnDemand, MIN_LIFE, REFRESH_WAIT, refreshDue, runRefresh } from "@/lib/light";
import { accountStatus, statusText } from "@/lib/client";
import { keepSlotsUp, setCheckMode, setLightMode } from "@/lib/slots";
import type { LightSignIn } from "@/shared/slot-db/state";
import { tempDir } from "./helpers";

const T0 = 1_790_000_000;
let db: Database.Database;
let clock: number;
let calls: string[];
let sign: LightSignIn | null;
let health: { ts: number; teams: string; inUse?: boolean } | null;
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

  it("at once when its owner asked to sign in, whatever its sign-in and the last run", () => {
    const n = slot();
    db.prepare("UPDATE teams_accounts SET refreshed=?, refresh_result='login' WHERE slot=?").run(T0 - 60, n);
    askRefresh(db, n);
    expect(refreshDue(slotRow(db, n)!, { at: T0 - 100, expiresOn: T0 + 3600, refused: false }, T0)).toBe(true);
    expect(refreshDue({ ...slotRow(db, n)!, refreshing: T0 - 10 }, null, T0)).toBe(false);
    expect(refreshDue({ ...slotRow(db, n)!, stopped: 1 }, null, T0)).toBe(false);
  });

  it("never starts a daily browser for a captured Microsoft session, even expired or refused", () => {
    const s = row({});
    for (const refused of [false, true]) {
      expect(refreshDue(s, { at: T0 - 86400, expiresOn: T0 - 1, refused, session: true }, T0)).toBe(false);
    }
    askRefresh(db, s.slot);
    expect(refreshDue(slotRow(db, s.slot)!, { at: 1, expiresOn: 2, refused: true, session: true }, T0)).toBe(true);
  });
});

describe("sign-in run of a light account", () => {
  it("keeps a legacy account's browser until this run captured its session, even while the old token holds", async () => {
    const n = slot();
    sign = { at: T0 - 100, expiresOn: T0 + 3600, refused: false };
    askRefresh(db, n);
    onSleep = (s) => {
      if (s >= T0 + 8) sign = { at: s, expiresOn: T0 + 3600, refused: false, session: true };
    };
    expect(await runRefresh(n, deps())).toBe("ok");
    expect(secs()).toBe(T0 + 8);
    expect(calls).toEqual([`start ${n}`, `light ${n}`]);
  });

  it("finishes capture once the Microsoft session is saved, even with an old SPA refresh token", async () => {
    const n = slot();
    onSleep = (s) => void (sign = { at: s, expiresOn: s - 1, refused: false, session: true });
    expect(await runRefresh(n, deps())).toBe("ok");
    expect(secs()).toBe(T0 + 2);
    expect(calls).toEqual([`start ${n}`, `light ${n}`]);
  });
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

  it("asked by its owner, waits SIGN_IN_WAIT for the sign-in in the remote desktop while Teams is signed out", async () => {
    const n = slot();
    askRefresh(db, n);
    onSleep = (s) => {
      health = { ts: s, teams: "login" };
      if (s >= T0 + SIGNED_OUT + 120) sign = { at: s, expiresOn: s + 86_000, refused: false };
    };
    expect(await runRefresh(n, deps())).toBe("ok");
    expect(slotRow(db, n)).toMatchObject({ refreshing: 0, refresh_result: "ok" });

    const m = slot();
    askRefresh(db, m);
    sign = null;
    onSleep = (s) => void (health = { ts: s, teams: "login" });
    expect(await runRefresh(m, deps())).toBe("login");
    expect(slotRow(db, m)!.refresh_result).toBe("login");
  });

  it("asked while a run goes on, that run waits for the sign-in", async () => {
    const n = slot();
    onSleep = (s) => {
      health = { ts: s, teams: "login" };
      if (s === T0 + 10) askRefresh(db, n);
    };
    const begun = secs();
    expect(await runRefresh(n, deps())).toBe("login");
    expect(secs() - begun).toBeGreaterThanOrEqual(SIGN_IN_WAIT);
  });

  it("asked, keeps the browser while the owner is on the remote desktop, until SIGN_IN_WAIT after they left", async () => {
    const n = slot();
    askRefresh(db, n);
    const left = T0 + 2 * SIGN_IN_WAIT;
    onSleep = (s) => void (health = { ts: s, teams: "login", inUse: s < left });
    expect(await runRefresh(n, deps())).toBe("login");
    expect(secs() - left).toBeGreaterThanOrEqual(SIGN_IN_WAIT - 2);
    expect(secs() - left).toBeLessThanOrEqual(SIGN_IN_WAIT + 2);
  });

  it("cut short, forgets the ask", () => {
    const n = slot();
    askRefresh(db, n);
    endRefresh(db, n, { now: 0, result: null });
    expect(slotRow(db, n)!.refresh_result).toBe("");
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

describe("browser of a light account on demand", () => {
  const o = () => ({ now: () => clock, sleep });

  it("asks a sign-in run and waits until its browser runs", async () => {
    const n = slot();
    onSleep = (s) => {
      if (s === T0 + 12) db.prepare("UPDATE teams_accounts SET refreshing=? WHERE slot=?").run(s, n);
    };
    expect(await browserOnDemand(db, n, o())).toBe(true);
    expect(slotRow(db, n)!.refresh_result).toBe("asked");
    expect(secs()).toBe(T0 + 12);
  });

  it("gives up after BROWSER_WAIT, and asks nothing of an account with a browser or not light", async () => {
    const n = slot();
    expect(await browserOnDemand(db, n, o())).toBe(false);
    expect(secs() - T0).toBeGreaterThanOrEqual(BROWSER_WAIT);
    const running = slot();
    db.prepare("UPDATE teams_accounts SET refreshing=? WHERE slot=?").run(T0, running);
    const plain = slot(false);
    const before = secs();
    expect(await browserOnDemand(db, running, o())).toBe(true);
    expect(await browserOnDemand(db, plain, o())).toBe(true);
    expect(secs()).toBe(before);
    expect(slotRow(db, running)!.refresh_result).toBe("");
    expect(slotRow(db, plain)!.refresh_result).toBe("");
  });
});

describe("light mode of an account", () => {
  it("keeps the browser of an account always on until the sign-in run, starts the light agent of a stopped or checked one", async () => {
    const on = slot(false);
    db.prepare("UPDATE teams_accounts SET refreshed=?, refresh_result='login' WHERE slot=?").run(T0 - 60, on);
    await setLightMode(on, ctl, db);
    expect(calls).toEqual([]);
    expect(slotRow(db, on)).toMatchObject({ light: 1, check_every: 0, refresh_result: "asked" });
    expect(refreshDue(slotRow(db, on)!, null, T0)).toBe(true);

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

  it("is kept up as its light agent, not while its browser runs to sign in or a run is asked", async () => {
    const a = slot();
    const b = slot();
    db.prepare("UPDATE teams_accounts SET refreshing=? WHERE slot=?").run(T0, b);
    const c = slot(false);
    const d = slot();
    askRefresh(db, d);
    clearInterval(keepSlotsUp(ctl, db, 1_000_000));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([`light ${a}`, `start ${c}`]);
    expect(listSlots(db).map((s) => s.light)).toEqual([1, 1, 0, 1]);
  });

  it("shows as always on without browser in the app", () => {
    const a = { stopped: false, checkEvery: 0, checking: false, nextCheck: 0, light: true, refreshing: false };
    expect(accountStatus(a)).toBe("light");
    expect(statusText(a)).toBe("Active, no browser");
    expect(statusText({ ...a, refreshing: true })).toBe("Signing in again");
    expect(statusText({ ...a, teams: "login" })).toBe("Signed out");
  });
});
