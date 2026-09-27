import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { askCheck, CHECK_INTERVALS, claimSlot, listSlots, releaseSlot, setCheckEvery, setSlotStopped, slotRow } from "./appdb";
import type { ControlClient } from "./control";
import { HttpError } from "./http";

export type SlotPaths = { dataDir: string };
export type SlotOptions = SlotPaths & { db: Database.Database; slotCount: number; perUser: number };

// Browser and agent of the slot, in the browsers container: the supervisor starts the browser before the agent
// and stops them the other way round.
export const slotUp = (ctl: ControlClient, n: number) => ctl.start(n);
export const slotDown = (ctl: ControlClient, n: number) => ctl.stop(n);

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

export function removeAccount(n: number, ctl: ControlClient, o: Omit<SlotOptions, "slotCount" | "perUser">): Promise<void> {
  return exclusive(async () => {
    await slotDown(ctl, n);
    await wipeSlot(ctl, n, o);
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
    if (!running) await slotDown(ctl, n);
    else if (!s.check_every) await slotUp(ctl, n);
    setSlotStopped(db, n, !running);
    if (running && s.check_every) askCheck(db, n);
  });
}

// Always on (every 0), or checked every `every` seconds: its browser runs only while it is checked (src/lib/checks.ts),
// so it stops now, unless a check runs; back to always on, it starts now. The app shows one status per account (stopped,
// always on, checked every N): a stopped account given a mode is back in service, checked ones with a check asked.
export function setCheckMode(n: number, every: number, ctl: ControlClient, db: Database.Database, now = Math.floor(Date.now() / 1000)): Promise<void> {
  if (every !== 0 && !(CHECK_INTERVALS as readonly number[]).includes(every)) {
    return Promise.reject(new HttpError(400, `checkEvery must be 0 or one of ${CHECK_INTERVALS.join(", ")}`));
  }
  return exclusive(async () => {
    const s = slotRow(db, n);
    if (!s) throw new HttpError(404, "Account not found");
    // the browser first: a start or stop that fails leaves the mode as it was
    if (!every) await slotUp(ctl, n);
    else if (!s.stopped && !s.checking) await slotDown(ctl, n);
    setCheckEvery(db, n, every, now);
    if (!s.stopped) return;
    setSlotStopped(db, n, false);
    // stopped, its chats are old: checked at once
    if (every) askCheck(db, n);
  });
}

// Owned slots must be running, unless their owner stopped them or they run only while checked: after a deploy
// recreated a container, a reboot, or a stop outside the app.
export function keepSlotsUp(ctl: ControlClient, db: Database.Database, everyMs = 60_000) {
  const tick = () =>
    exclusive(async () => {
      for (const { slot, stopped, check_every } of listSlots(db)) {
        if (stopped || check_every) continue;
        await slotUp(ctl, slot).catch((e: Error) => console.error(`slot ${slot}: ${e.message}`));
      }
    });
  void tick();
  return setInterval(() => void tick(), everyMs);
}
