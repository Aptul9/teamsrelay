import { setTimeout as wait } from "node:timers/promises";
import type Database from "better-sqlite3";
import { SIGN_IN_TRY_AFTER, SIGN_IN_TRY_WAIT } from "@/shared/sign-in";
import { STATE, Watch } from "@/shared/slot-db/state";
import { beginCheck, endCheck, listSlots, nextCheck, slotRow, type CheckResult } from "./appdb";
import type { ControlClient } from "./control";
import { exclusive, slotDown, slotUp } from "./slots";
import { SlotNotReady, withSlot, type SlotReader } from "./slotdb";

// An account checked every N hours (check_every > 0) runs only while it is checked: started, read, stopped. One check
// at a time, the one due first first: several browsers starting together would not fit in memory. A check holds
// exclusive() only to start and to stop the account, never while it waits for Teams: a start or a stop from the app
// does not wait for it.

// What a check reads and queues in the database of the account (data/N/messages.db)
export type SlotPort = {
  // the agent's health row: Unix seconds it was written and the Teams state; null while there is none
  health(n: number): { ts: number; teams: string } | null;
  // the agent pushes "Teams signed out" after a minute signed out, only for an account signed in once (armed)
  signInAlert(n: number): { armed: boolean; alerted: boolean };
  // queues the check command: the whole chat list and the Activity feed, then the summary push
  enqueue(n: number): number;
  // pending, done or failed; null for an unknown command
  commandStatus(n: number, id: number): string | null;
};

export type CheckDeps = {
  ctl: ControlClient;
  db: Database.Database;
  slot: SlotPort;
  // milliseconds, and a pause: a fake clock in the tests
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

// Seconds a check waits for Teams after the start (browser, Microsoft redirects, Teams loading). A Teams signed out
// SIGNED_OUT seconds is a sign-in to do, not a redirect of the start, which lasts a few seconds, nor a sign-out the
// agent's one press of Sign in ends (src/agent/jobs/sign-in.ts): longer than that press and its wait together.
export const TEAMS_WAIT = 240;
export const SIGNED_OUT = SIGN_IN_TRY_AFTER + SIGN_IN_TRY_WAIT + 15;
// Seconds for the check command, and for the agent's sign-in alert once a sign-in is found to do
export const COMMAND_WAIT = 180;
export const ALERT_WAIT = 30;
// A check its owner asks for, of an account whose last check found a sign-in to do, waits that long for the sign-in
// in the remote desktop
export const SIGN_IN_WAIT = 600;

const report = (n: number) => (e: Error) => console.error(`check of account ${n}: ${e.message}`);

// Starts the account, waits for Teams, has the agent read the chat list and the Activity feed, stops it. The outcome
// is recorded: ok, login (a Microsoft sign-in to do) or failed. null: the account was stopped, removed or set back to
// always on meanwhile; nothing is recorded and the browser is left as its owner wants it.
export async function runCheck(n: number, d: CheckDeps): Promise<CheckResult | null> {
  const now = () => Math.floor((d.now ?? Date.now)() / 1000);
  const sleep = d.sleep ?? ((ms: number) => wait(ms));
  const begun = now();
  let asked = false;
  let signIn = false;
  const started = await exclusive(async () => {
    const s = slotRow(d.db, n);
    if (!s || s.stopped || !s.check_every) return false;
    asked = s.check_due === 0;
    // asked from the app for an account whose last check found a sign-in to do, or never signed in
    signIn = asked && (s.check_result === "login" || !d.slot.signInAlert(n).armed);
    beginCheck(d.db, n, begun);
    try {
      await slotUp(d.ctl, n);
    } catch (e) {
      // no answer in time: the supervisor may still be starting it, and a stop queued after the start ends it
      report(n)(e as Error);
      await slotDown(d.ctl, n).catch(report(n));
      endCheck(d.db, n, { now: now(), result: "failed", asked });
      return "failed" as const;
    }
    return true;
  });
  if (started !== true) return started || null;

  // still checked and in service
  const current = () => {
    const s = slotRow(d.db, n);
    return !!s && !s.stopped && !!s.check_every;
  };
  let result: CheckResult | null = "failed";
  try {
    result = await waitAndRead(n, d, { begun, now, sleep, current, signIn });
  } finally {
    await exclusive(async () => {
      const s = slotRow(d.db, n);
      // stopped by its owner meanwhile: already down; back to always on: it stays up
      if (s && !s.stopped && s.check_every) await slotDown(d.ctl, n).catch(report(n));
      if (s) endCheck(d.db, n, { now: now(), result, asked });
    });
  }
  return result;
}

type Loop = { begun: number; now: () => number; sleep: (ms: number) => Promise<void>; current: () => boolean; signIn: boolean };

async function waitAndRead(n: number, d: CheckDeps, o: Loop): Promise<CheckResult | null> {
  // only a row written after the start describes this run of Teams: the last one is from the previous check
  let signedOutSince = 0;
  for (;;) {
    if (!o.current()) return null;
    const h = d.slot.health(n);
    const fresh = !!h && h.ts >= o.begun;
    if (fresh && h.teams === "ok") return readAll(n, d, o);
    if (fresh && h.teams === "login") signedOutSince ||= o.now();
    else if (fresh) signedOutSince = 0;
    // a check asked to sign in waits for the sign-in; the others end once Teams stays signed out
    if (!o.signIn && signedOutSince && o.now() - signedOutSince >= SIGNED_OUT) {
      await waitForAlert(n, d, o);
      return "login";
    }
    if (o.now() - o.begun >= (o.signIn ? SIGN_IN_WAIT : TEAMS_WAIT)) {
      if (!signedOutSince) return "failed";
      await waitForAlert(n, d, o);
      return "login";
    }
    await o.sleep(2000);
  }
}

async function readAll(n: number, d: CheckDeps, o: Loop): Promise<CheckResult | null> {
  const id = d.slot.enqueue(n);
  const until = o.now() + COMMAND_WAIT;
  // Teams can show its chats from its cache, then send the browser to the Microsoft sign-in
  let signedOutSince = 0;
  while (o.now() < until) {
    if (!o.current()) return null;
    const status = d.slot.commandStatus(n, id);
    if (status === "done") return "ok";
    if (status === "failed") return "failed";
    const h = d.slot.health(n);
    if (h && h.ts >= o.begun && h.teams === "login") signedOutSince ||= o.now();
    else signedOutSince = 0;
    if (signedOutSince && o.now() - signedOutSince >= SIGNED_OUT) {
      await waitForAlert(n, d, o);
      return "login";
    }
    await o.sleep(1000);
  }
  return "failed";
}

// The agent pushes its "Teams signed out" alert after a minute signed out: the account stays up until it has
async function waitForAlert(n: number, d: CheckDeps, o: Loop) {
  const until = o.now() + ALERT_WAIT;
  while (o.now() < until) {
    const { armed, alerted } = d.slot.signInAlert(n);
    if (!armed || alerted) return;
    await o.sleep(2000);
  }
}

// Every check due now, one after the other; an account asked for meanwhile comes next. An account comes once per
// call: asked again during its own round, it waits for the next call.
export async function runDueChecks(d: CheckDeps) {
  const now = () => Math.floor((d.now ?? Date.now)() / 1000);
  const done = new Set<number>();
  for (let s = nextCheck(d.db, now()); s && !done.has(s.slot); s = nextCheck(d.db, now())) {
    done.add(s.slot);
    await runCheck(s.slot, d);
  }
}

// The loop of the web app: the checks due, every `everyMs`
export function runChecks(d: CheckDeps, everyMs = 10_000) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runDueChecks(d);
    } catch (e) {
      console.error(`checks: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
    }
  };
  void tick();
  return setInterval(() => void tick(), everyMs);
}

// At boot: the browser of a checked account runs only during a check, and no check runs yet. One cut by a restart of
// the web app left it running.
export function settleChecks(ctl: ControlClient, db: Database.Database): Promise<void> {
  return exclusive(async () => {
    for (const s of listSlots(db)) {
      if (!s.check_every || s.stopped) continue;
      await slotDown(ctl, s.slot).catch(report(s.slot));
      if (s.checking) endCheck(db, s.slot, { now: 0, result: null });
    }
  });
}

// The database of each account as the checks of the web app read it; an account whose agent never ran has none
export function slotPort(): SlotPort {
  const read = <T>(n: number, fn: (r: SlotReader) => T, fallback: T): T => {
    try {
      return withSlot(n, fn);
    } catch (e) {
      if (e instanceof SlotNotReady) return fallback;
      throw e;
    }
  };
  return {
    health: (n) =>
      read(
        n,
        (r) => {
          const h = r.state<{ ts?: unknown; teams?: unknown }>(STATE.health, {});
          return typeof h.ts === "number" && typeof h.teams === "string" ? { ts: h.ts, teams: h.teams } : null;
        },
        null,
      ),
    // armed as the agent arms it: a signed-in identity saved once
    signInAlert: (n) =>
      read(n, (r) => ({ armed: r.state<unknown>(STATE.me, null) !== null, alerted: Watch.safeParse(r.state<unknown>(STATE.loginWatch, {})).data?.alerted ?? false }), {
        armed: false,
        alerted: false,
      }),
    enqueue: (n) => withSlot(n, (r) => r.enqueue("check")),
    commandStatus: (n, id) => read(n, (r) => r.commandStatus(id)?.status ?? null, null),
  };
}
