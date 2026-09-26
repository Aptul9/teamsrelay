import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { claimSlot, listSlots, releaseSlot } from "./appdb";
import type { DockerClient } from "./docker";
import { HttpError } from "./http";

export type SlotPaths = { dataDir: string; wipeDir: string };
export type SlotOptions = SlotPaths & { db: Database.Database; slotCount: number; perUser: number };

const containers = (n: number) => ({ chromium: `teams-chromium-${n}`, agent: `teams-agent-${n}`, wipe: `teams-wipe-${n}` });

// The agent uses the network of its Chromium: browser first on the way up, agent first on the way down.
export async function slotUp(docker: DockerClient, n: number) {
  await docker.start(containers(n).chromium);
  await docker.start(containers(n).agent);
}

export async function slotDown(docker: DockerClient, n: number) {
  await docker.stop(containers(n).agent);
  await docker.stop(containers(n).chromium);
}

// Browser profile (the Microsoft session) and agent data of the slot, with the slot stopped. The web app
// has no access to the profiles: config/N is mounted only by chromium-N and by teams-wipe-N, which
// empties it. The container deletes only when it finds the request file in the wipe volume, so a
// "docker compose up" of the whole profile starts it for nothing.
export async function wipeSlot(docker: DockerClient, n: number, paths: SlotPaths) {
  const wipe = containers(n).wipe;
  const request = path.join(paths.wipeDir, String(n));
  fs.mkdirSync(paths.wipeDir, { recursive: true });
  fs.writeFileSync(request, "");
  try {
    await docker.start(wipe);
    const code = await docker.wait(wipe);
    if (code !== 0) throw new HttpError(502, `Wipe of slot ${n} failed (exit code ${code}): see docker logs ${wipe}`);
  } finally {
    fs.rmSync(request, { force: true });
  }
  fs.rmSync(path.join(paths.dataDir, String(n)), { recursive: true, force: true });
}

// Add, remove and the keep-alive loop run one at a time: a slot just stopped is not started again.
let queue: Promise<unknown> = Promise.resolve();
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export function addAccount(userId: string, docker: DockerClient, o: SlotOptions): Promise<number> {
  return exclusive(async () => {
    const n = claimSlot(o.db, userId, { slotCount: o.slotCount, perUser: o.perUser });
    try {
      await slotDown(docker, n).catch(() => undefined);
      await wipeSlot(docker, n, o);
      await slotUp(docker, n);
    } catch (e) {
      releaseSlot(o.db, n);
      throw e;
    }
    return n;
  });
}

export function removeAccount(n: number, docker: DockerClient, o: Omit<SlotOptions, "slotCount" | "perUser">): Promise<void> {
  return exclusive(async () => {
    await slotDown(docker, n);
    await wipeSlot(docker, n, o);
    releaseSlot(o.db, n);
  });
}

// Owned slots must be running: after a deploy recreated a container, a reboot, or a manual stop.
export function keepSlotsUp(docker: DockerClient, db: Database.Database, everyMs = 60_000) {
  const tick = () =>
    exclusive(async () => {
      for (const { slot } of listSlots(db)) {
        await slotUp(docker, slot).catch((e: Error) => console.error(`slot ${slot}: ${e.message}`));
      }
    });
  void tick();
  return setInterval(() => void tick(), everyMs);
}
