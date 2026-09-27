import path from "node:path";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { askCheck, migrateAppSchema, openAppDb, slotRow } from "@/lib/appdb";
import { ALERT_WAIT, runCheck, runDueChecks, settleChecks, SIGN_IN_WAIT, SIGNED_OUT, TEAMS_WAIT, type SlotPort } from "@/lib/checks";
import type { ControlClient } from "@/lib/control";
import { keepSlotsUp, setAccountRunning, setCheckMode } from "@/lib/slots";
import { tempDir } from "./helpers";

// Time is a fake clock that only the sleeps of the checks move; `at` runs something at a second of it, such as a user
// action in the middle of a check. Each account behaves as its browser and agent would: started by the control client,
// it writes a fresh health row once Teams is up (before that, the row of its last run), and a check command takes
// some seconds.
type Fake = {
  up: boolean;
  since: number;
  teams: (elapsed: number) => string;
  readyAfter: number;
  checkTakes: number;
  commands: Map<number, number>;
  armed: boolean;
  alertAfter: number;
};

const T0 = 1_790_000_000;
let db: Database.Database;
let clock: number;
let calls: string[];
let fakes: Map<number, Fake>;
let events: { at: number; run: () => void }[];

const secs = () => Math.floor(clock / 1000);
const sleep = async (ms: number) => {
  clock += ms;
  for (const e of events.filter((x) => x.at <= secs())) {
    events.splice(events.indexOf(e), 1);
    e.run();
  }
  await new Promise((r) => setImmediate(r));
};
const at = (s: number, run: () => void) => events.push({ at: T0 + s, run });

function control(): ControlClient {
  return {
    start: async (n) => {
      calls.push(`start ${n}@${secs() - T0}`);
      const f = fakes.get(n)!;
      if (!f.up) Object.assign(f, { up: true, since: secs() });
    },
    stop: async (n) => {
      calls.push(`stop ${n}@${secs() - T0}`);
      fakes.get(n)!.up = false;
    },
    wipe: async () => undefined,
    show: async () => true,
  };
}

const port: SlotPort = {
  health(n) {
    const f = fakes.get(n)!;
    const elapsed = secs() - f.since;
    // the row the agent wrote before it stopped, an hour ago: Teams was fine then
    if (!f.up || elapsed < f.readyAfter) return { ts: T0 - 3600, teams: "ok" };
    return { ts: secs(), teams: f.teams(elapsed) };
  },
  signInAlert(n) {
    const f = fakes.get(n)!;
    return { armed: f.armed, alerted: f.up && secs() - f.since >= f.alertAfter };
  },
  enqueue(n) {
    const f = fakes.get(n)!;
    const id = f.commands.size + 1;
    f.commands.set(id, secs());
    return id;
  },
  commandStatus(n, id) {
    const f = fakes.get(n)!;
    return secs() - (f.commands.get(id) ?? secs()) >= f.checkTakes ? "done" : "pending";
  },
};

const deps = () => ({ ctl: control(), db, slot: port, now: () => clock, sleep });

function account(n: number, every: number, due: number, fake: Partial<Fake> = {}) {
  db.prepare("INSERT INTO teams_accounts(slot, owner_id, added, check_every, check_due) VALUES(?,?,?,?,?)").run(n, "u1", 1, every, due);
  fakes.set(n, { up: false, since: 0, teams: () => "ok", readyAfter: 40, checkTakes: 20, commands: new Map(), armed: true, alertAfter: Infinity, ...fake });
}

beforeEach(() => {
  db = openAppDb(path.join(tempDir(), "app.db"));
  migrateAppSchema(db);
  clock = T0 * 1000;
  calls = [];
  fakes = new Map();
  events = [];
});

describe("a check", () => {
  it("starts the account, waits for a fresh health row with Teams ok, has the agent read, stops it, records it", async () => {
    account(1, 3600, T0);
    expect(await runCheck(1, deps())).toBe("ok");
    expect(calls).toEqual(["start 1@0", "stop 1@60"]);
    expect(fakes.get(1)!.commands.size).toBe(1);
    expect(slotRow(db, 1)).toMatchObject({ checked: T0 + 60, check_result: "ok", check_due: T0 + 60 + 3600, checking: 0 });
  });

  it("does not take a sign-out of a few seconds while Teams starts (Microsoft redirects) for a sign-in to do", async () => {
    account(1, 3600, T0, { teams: (elapsed) => (elapsed < 50 ? "login" : "ok") });
    expect(await runCheck(1, deps())).toBe("ok");
  });

  it("finds a sign-in to do after a minute signed out, and stops the account once the agent pushed its alert", async () => {
    account(1, 3600, T0, { teams: () => "login", alertAfter: 40 + SIGNED_OUT + 6 });
    expect(await runCheck(1, deps())).toBe("login");
    expect(fakes.get(1)!.commands.size).toBe(0);
    const stop = Number(calls.at(-1)!.split("@")[1]);
    expect(stop).toBeGreaterThanOrEqual(40 + SIGNED_OUT + 6);
    expect(stop).toBeLessThan(40 + SIGNED_OUT + ALERT_WAIT);
    expect(slotRow(db, 1)).toMatchObject({ check_result: "login", checking: 0 });
  });

  it("does not wait for an alert the agent never sends: an account never signed in", async () => {
    account(1, 3600, T0, { teams: () => "login", armed: false });
    expect(await runCheck(1, deps())).toBe("login");
    expect(Number(calls.at(-1)!.split("@")[1])).toBeLessThan(40 + SIGNED_OUT + 3);
  });

  it("waits up to ten minutes for a sign-in when its owner asks for a check of an account that needs one", async () => {
    account(1, 3600, 0, { teams: (elapsed) => (elapsed < 300 ? "login" : "ok") });
    db.prepare("UPDATE teams_accounts SET check_result='login' WHERE slot=1").run();
    expect(await runCheck(1, deps())).toBe("ok");
    expect(SIGN_IN_WAIT).toBeGreaterThan(300);
  });

  it("waits up to ten minutes for a sign-in when its owner asks for a check of an account never signed in", async () => {
    account(1, 3600, 0, { teams: (elapsed) => (elapsed < 300 ? "login" : "ok"), armed: false });
    expect(await runCheck(1, deps())).toBe("ok");
  });

  it("waits for the agent's alert also when the sign-out began late and the wait ran out", async () => {
    account(1, 3600, T0, { teams: (elapsed) => (elapsed < 200 ? "loading" : "login"), alertAfter: 262 });
    expect(await runCheck(1, deps())).toBe("login");
    expect(Number(calls.at(-1)!.split("@")[1])).toBeGreaterThanOrEqual(262);
  });

  it("finds a sign-in to do when Teams signs out while the agent reads", async () => {
    account(1, 3600, T0, { teams: (elapsed) => (elapsed < 45 ? "ok" : "login"), checkTakes: 100_000, alertAfter: 110 });
    expect(await runCheck(1, deps())).toBe("login");
    expect(Number(calls.at(-1)!.split("@")[1])).toBeLessThan(200);
  });

  it("records a start that failed, and stops the account all the same: the supervisor may still be starting it", async () => {
    account(1, 3600, T0);
    const ctl = control();
    ctl.start = async (n) => {
      calls.push(`start ${n}@${secs() - T0}`);
      throw new Error("no answer within 40 s");
    };
    expect(await runCheck(1, { ...deps(), ctl })).toBe("failed");
    expect(calls).toEqual(["start 1@0", "stop 1@0"]);
    expect(slotRow(db, 1)).toMatchObject({ check_result: "failed", checking: 0, check_due: T0 + 3600 });
  });

  it("fails when Teams is never ready, and stops the account all the same", async () => {
    account(1, 3600, T0, { readyAfter: 100_000 });
    expect(await runCheck(1, deps())).toBe("failed");
    expect(calls[0]).toBe("start 1@0");
    expect(Number(calls.at(-1)!.split("@")[1])).toBeGreaterThanOrEqual(TEAMS_WAIT);
    expect(slotRow(db, 1)).toMatchObject({ check_result: "failed", checking: 0 });
  });

  it("ends when its owner stops the account meanwhile, without starting it again, and the stop does not wait for it", async () => {
    account(1, 3600, T0, { readyAfter: 100_000 });
    let stopTook = -1;
    at(4, () => {
      const from = secs();
      void setAccountRunning(1, false, control(), db).then(() => (stopTook = secs() - from));
    });
    expect(await runCheck(1, deps())).toBeNull();
    expect(stopTook).toBe(0);
    expect(calls).toEqual(["start 1@0", "stop 1@4"]);
    expect(slotRow(db, 1)).toMatchObject({ stopped: 1, checking: 0, checked: 0 });
  });

  it("leaves the account running when its owner sets it back to always on meanwhile", async () => {
    account(1, 3600, T0, { readyAfter: 100_000 });
    at(5, () => void setCheckMode(1, 0, control(), db));
    expect(await runCheck(1, deps())).toBeNull();
    expect(fakes.get(1)!.up).toBe(true);
    expect(calls.filter((c) => c.startsWith("stop"))).toEqual([]);
  });
});

describe("the checks of the web app", () => {
  it("runs the checks due one after the other, the one due first first, and none before it is due", async () => {
    account(1, 3600, T0 - 10);
    account(2, 7200, T0 - 20);
    account(3, 3600, T0 + 100_000);
    await runDueChecks(deps());
    expect(calls.map((c) => c.split("@")[0])).toEqual(["start 2", "stop 2", "start 1", "stop 1"]);
  });

  it("starts an account asked for a check while another check runs only once that one is over", async () => {
    account(1, 3600, T0);
    account(2, 3600, T0 + 100_000);
    at(10, () => askCheck(db, 2));
    await runDueChecks(deps());
    expect(calls.map((c) => c.split("@")[0])).toEqual(["start 1", "stop 1", "start 2", "stop 2"]);
  });

  it("runs a check asked during a scheduled check of the same account right after it", async () => {
    account(1, 3600, T0);
    at(10, () => askCheck(db, 1));
    await runDueChecks(deps());
    expect(slotRow(db, 1)).toMatchObject({ check_due: 0 });
    await runDueChecks(deps());
    expect(calls.map((c) => c.split("@")[0])).toEqual(["start 1", "stop 1", "start 1", "stop 1"]);
  });

  it("checks nothing stopped by its owner, nor an account always on", async () => {
    account(1, 3600, T0 - 10);
    account(2, 0, 0);
    db.prepare("UPDATE teams_accounts SET stopped=1 WHERE slot=1").run();
    await runDueChecks(deps());
    expect(calls).toEqual([]);
  });

  it("at boot stops the browser of every checked account: a check cut by a restart of the web app left it running", async () => {
    account(1, 3600, T0 + 100);
    account(2, 3600, T0 + 100);
    account(3, 0, 0);
    db.prepare("UPDATE teams_accounts SET checking=? WHERE slot=1").run(T0 - 100);
    await settleChecks(control(), db);
    expect(calls.map((c) => c.split("@")[0])).toEqual(["stop 1", "stop 2"]);
    expect(slotRow(db, 1)).toMatchObject({ checking: 0, checked: 0 });
  });

  it("is left alone by the keep-alive, which starts only the accounts always on", async () => {
    account(1, 3600, T0 + 100);
    account(2, 0, 0);
    clearInterval(keepSlotsUp(control(), db, 60_000));
    await sleep(10);
    expect(calls.map((c) => c.split("@")[0])).toEqual(["start 2"]);
  });
});
