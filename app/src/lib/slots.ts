import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { claimSlot, listSlots, releaseSlot, setSlotStopped, slotOwner } from "./appdb";
import type { ControlClient } from "./control";
import { HttpError } from "./http";

export type SlotPaths = { dataDir: string };
export type SlotOptions = SlotPaths & { db: Database.Database; slotCount: number; perUser: number };

// Browser and agent of the slot, in the browsers container: the supervisor starts the browser before the agent
// and stops them the other way round.
export const slotUp = (ctl: ControlClient, n: number) => ctl.start(n);
export const slotDown = (ctl: ControlClient, n: number) => ctl.stop(n);

// Browser profile (the Microsoft session) and agent data of the slot, with the slot stopped. The web app has
// no access to the profiles: the supervisor empties config/N, then the web app deletes data/N.
export async function wipeSlot(ctl: ControlClient, n: number, paths: SlotPaths) {
  await ctl.wipe(n);
  fs.rmSync(path.join(paths.dataDir, String(n)), { recursive: true, force: true });
}

// Add, remove, stop, start and the keep-alive loop run one at a time: a slot just stopped is not started again.
let queue: Promise<unknown> = Promise.resolve();
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
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
// and the keep-alive loop leaves it alone until its owner starts it again.
export function setAccountRunning(n: number, running: boolean, ctl: ControlClient, db: Database.Database): Promise<void> {
  return exclusive(async () => {
    // removed while this request waited in the queue
    if (!slotOwner(db, n)) throw new HttpError(404, "Account not found");
    if (running) await slotUp(ctl, n);
    else await slotDown(ctl, n);
    setSlotStopped(db, n, !running);
  });
}

// Owned slots must be running, unless their owner stopped them: after a deploy recreated a container, a
// reboot, or a stop outside the app.
export function keepSlotsUp(ctl: ControlClient, db: Database.Database, everyMs = 60_000) {
  const tick = () =>
    exclusive(async () => {
      for (const { slot, stopped } of listSlots(db)) {
        if (stopped) continue;
        await slotUp(ctl, slot).catch((e: Error) => console.error(`slot ${slot}: ${e.message}`));
      }
    });
  void tick();
  return setInterval(() => void tick(), everyMs);
}
