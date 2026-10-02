import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { nowSeconds } from "@/agent/context";
import { askCheck, CHECK_INTERVALS, claimSlot, listSlots, releaseSlot, setCheckEvery, setRelayToken, setSlotStopped, slotRow } from "./appdb";
import type { ControlClient } from "./control";
import { HttpError } from "./http";
import { createRelaySlot, forgetRelay, newRelayToken, ON_ANOTHER_COMPUTER, relayDigest } from "./relay";
import { SlotNotReady, withSlot } from "./slotdb";

export type SlotPaths = { dataDir: string };
export type SlotOptions = SlotPaths & { db: Database.Database; slotCount: number; perUser: number };

// Browser and agent of the slot, in the browsers container: the supervisor starts the browser before the agent
// and stops them the other way round.
export const slotUp = (ctl: ControlClient, n: number) => ctl.start(n);
export const slotDown = (ctl: ControlClient, n: number) => ctl.stop(n);

// A start the supervisor did not confirm in time may still be under way: a stop queued after it ends it, so the account
// is not left running while it shows as stopped or checked
async function startOrUndo(ctl: ControlClient, n: number) {
  try {
    await slotUp(ctl, n);
  } catch (e) {
    await slotDown(ctl, n).catch(() => undefined);
    throw e;
  }
}

// The next check of the account starts from what it finds (src/agent/commands/check.ts): nothing it would compare with
// is left from before a change of mode or a start. An account whose agent has not created its database has nothing.
function forgetLastCheck(n: number) {
  try {
    withSlot(n, (r) => r.forgetLastCheck());
  } catch (e) {
    if (!(e instanceof SlotNotReady)) throw e;
  }
}

// Browser profile (the Microsoft session) and agent data of the slot, with the slot stopped. The web app has
// no access to the profiles: the supervisor deletes config/N, then the web app deletes data/N.
export async function wipeSlot(ctl: ControlClient, n: number, paths: SlotPaths) {
  await ctl.wipe(n);
  fs.rmSync(path.join(paths.dataDir, String(n)), { recursive: true, force: true });
}

// Add, remove, stop, start, the keep-alive loop and the start and stop of a check run one at a time: a slot just
// stopped is not started again. One queue for the whole process: the build gives the boot code (keep-alive, checks)
// and every route a copy of this module of its own.
const shared = globalThis as typeof globalThis & { teamsrelaySlotQueue?: Promise<unknown> };
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = (shared.teamsrelaySlotQueue ?? Promise.resolve()).then(fn, fn);
  shared.teamsrelaySlotQueue = run.catch(() => undefined);
  return run;
}

export function addAccount(userId: string, ctl: ControlClient, o: SlotOptions): Promise<number> {
  return exclusive(async () => {
    const n = claimSlot(o.db, userId, { slotCount: o.slotCount, perUser: o.perUser });
    try {
      await slotDown(ctl, n).catch(() => undefined);
      await wipeSlot(ctl, n, o);
      await slotUp(ctl, n);
    } catch (e) {
      releaseSlot(o.db, n);
      throw e;
    }
    return n;
  });
}

// New account on another computer: first free slot, its empty database, and the token its relay joins with (shown
// once: only its digest is kept). The supervisor has nothing to start.
export function addRelayAccount(userId: string, o: SlotOptions): Promise<{ slot: number; token: string }> {
  return exclusive(async () => {
    const n = claimSlot(o.db, userId, { slotCount: o.slotCount, perUser: o.perUser });
    try {
      // a notifier left from an earlier account of the slot (a push that raced its removal) writes nowhere any more
      forgetRelay(n);
      createRelaySlot(path.join(o.dataDir, String(n)));
      const token = newRelayToken();
      setRelayToken(o.db, n, relayDigest(token));
      return { slot: n, token };
    } catch (e) {
      releaseSlot(o.db, n);
      throw e;
    }
  });
}

// A new token for the relay of an account on another computer: the previous one stops working at once
export function renewRelayToken(n: number, db: Database.Database): Promise<string> {
  return exclusive(async () => {
    const s = slotRow(db, n);
    if (!s) throw new HttpError(404, "Account not found");
    if (!s.relay) throw new HttpError(409, "This Teams account runs on this server: it has no relay token");
    const token = newRelayToken();
    setRelayToken(db, n, relayDigest(token));
    return token;
  });
}

// An account on another computer loses its data here; its relay, refused from now on, keeps its own until stopped
export function removeAccount(n: number, ctl: ControlClient, o: Omit<SlotOptions, "slotCount" | "perUser">): Promise<void> {
  return exclusive(async () => {
    if (slotRow(o.db, n)?.relay) {
      forgetRelay(n);
      fs.rmSync(path.join(o.dataDir, String(n)), { recursive: true, force: true });
    } else {
      await slotDown(ctl, n);
      await wipeSlot(ctl, n, o);
    }
    releaseSlot(o.db, n);
  });
}

// Switches an account off or on without signing it out: stopped, it keeps its Microsoft session and data,
// and the keep-alive loop leaves it alone until its owner starts it again. A checked account started again is in
// service: its browser starts at its next check, asked at once.
export function setAccountRunning(n: number, running: boolean, ctl: ControlClient, db: Database.Database): Promise<void> {
  return exclusive(async () => {
    // removed while this request waited in the queue
    const s = slotRow(db, n);
    if (!s) throw new HttpError(404, "Account not found");
    if (s.relay) throw new HttpError(409, ON_ANOTHER_COMPUTER);
    if (!running) await slotDown(ctl, n);
    else if (!s.check_every) await startOrUndo(ctl, n);
    setSlotStopped(db, n, !running);
    if (running) forgetLastCheck(n);
    if (running && s.check_every) askCheck(db, n);
  });
}

// Always on (every 0), or checked every `every` seconds: its browser runs only while it is checked (src/lib/checks.ts),
// so it stops now, unless a check runs; back to always on, it starts now. The app shows one status per account (stopped,
// always on, checked every N): a stopped account given a mode is back in service, checked ones with a check asked.
export function setCheckMode(n: number, every: number, ctl: ControlClient, db: Database.Database, now = nowSeconds()): Promise<void> {
  if (every !== 0 && !(CHECK_INTERVALS as readonly number[]).includes(every)) {
    return Promise.reject(new HttpError(400, `checkEvery must be 0 or one of ${CHECK_INTERVALS.join(", ")}`));
  }
  return exclusive(async () => {
    const s = slotRow(db, n);
    if (!s) throw new HttpError(404, "Account not found");
    if (s.relay) throw new HttpError(409, ON_ANOTHER_COMPUTER);
    // the browser first: a start or stop that fails leaves the mode as it was
    if (!every) await startOrUndo(ctl, n);
    else if (!s.stopped && !s.checking) await slotDown(ctl, n);
    setCheckEvery(db, n, every, now);
    forgetLastCheck(n);
    // in service; a start from now on (the grace of a browser starting counts from it)
    if (!every || s.stopped) setSlotStopped(db, n, false);
    // stopped, its chats are old: checked at once
    if (every && s.stopped) askCheck(db, n);
  });
}

// Owned slots must be running, unless their owner stopped them or they run only while checked: after a deploy
// recreated a container, a reboot, or a stop outside the app. An account on another computer runs there.
export function keepSlotsUp(ctl: ControlClient, db: Database.Database, everyMs = 60_000) {
  const tick = () =>
    exclusive(async () => {
      for (const { slot, stopped, check_every, relay } of listSlots(db)) {
        if (stopped || check_every || relay) continue;
        await slotUp(ctl, slot).catch((e: Error) => console.error(`slot ${slot}: ${e.message}`));
      }
    });
  void tick();
  return setInterval(() => void tick(), everyMs);
}
