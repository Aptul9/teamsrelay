import fs from "node:fs";
import path from "node:path";

// One process at a time on the browser profile, the relay or the sign-in: Chrome would hand a second launch over to
// the browser already running on it and Playwright would only see it exit. The lock file names the holder; a lock
// whose process is gone (crash, pm2 restart) is taken over.

export class LockError extends Error {}

type Holder = { pid: number; mode: string; since: string };

function holder(file: string): Holder | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Holder;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Returns the release function
export function acquireLock(file: string, mode: "relay" | "login"): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, mode, since: new Date().toISOString() } satisfies Holder), { flag: "wx" });
      return () => {
        if (holder(file)?.pid === process.pid) fs.rmSync(file, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const h = holder(file);
      if (h && h.pid !== process.pid && alive(h.pid)) {
        throw new LockError(`the ${h.mode} is running on this profile (pid ${h.pid}, since ${h.since})`);
      }
      fs.rmSync(file, { force: true });
    }
  }
  throw new LockError(`lock ${file} could not be taken`);
}
