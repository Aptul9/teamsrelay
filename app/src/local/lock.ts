import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "@/agent/log";

// One process at a time on the browser profile, the relay or the sign-in: Chrome would hand a second launch over to
// the browser already running on it and Playwright would only see it exit. The lock file names the holder, who keeps
// its time up to date. A lock that no longer holds is taken over: its process is gone (crash, pm2 restart), it was
// written before the machine started (the pid may belong to anybody now), its holder stopped keeping it up to date,
// or it is a sign-in lock older than a sign-in can last.

// the sign-in waits this long for someone at the window
export const LOGIN_TIMEOUT_MS = 15 * 60_000;
// the holder moves the time of the file on this often; a file not moved on for STALE_MS has no holder any more
const BEAT_MS = 30_000;
const STALE_MS = 2 * 60_000;
// a file without its content yet: the process that created it is writing it
const WRITING_MS = 5_000;

export class LockError extends Error {
  // what holds the lock: "relay" or "login"; empty when it could not be taken for another reason
  constructor(
    message: string,
    readonly heldBy = "",
  ) {
    super(message);
  }
}

type Holder = { pid: number; mode: string; since: string };

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function parse(raw: string | null): Holder | null {
  try {
    const h = JSON.parse(raw ?? "") as Partial<Holder> | null;
    return h && typeof h.pid === "number" ? { pid: h.pid, mode: String(h.mode ?? ""), since: String(h.since ?? "") } : null;
  } catch {
    return null;
  }
}

const holder = (file: string) => parse(read(file));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Why the lock of another process no longer holds; "" while it does
function stale(h: Holder | null, touched: number, now = Date.now()): string {
  if (!h) return now - touched > WRITING_MS ? "unreadable" : "";
  // our own pid in it: a lock left by an earlier process that had the same pid
  if (h.pid === process.pid || !alive(h.pid)) return "process gone";
  const since = Date.parse(h.since);
  const booted = now - os.uptime() * 1000;
  if (!(since >= booted - 5_000)) return "written before the machine started";
  if (now - touched > STALE_MS) return "not kept up to date";
  if (h.mode === "login" && now - since > LOGIN_TIMEOUT_MS + 5 * 60_000) return "sign-in over";
  return "";
}

// Returns the release function. `beatMs`: how often the time of the lock moves on while it is held.
export function acquireLock(file: string, mode: "relay" | "login", beatMs = BEAT_MS): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, mode, since: new Date().toISOString() } satisfies Holder), { flag: "wx" });
      const beat = setInterval(() => {
        try {
          const now = new Date();
          fs.utimesSync(file, now, now);
        } catch {
          // gone, or taken over: nothing to keep up to date
        }
      }, beatMs);
      beat.unref();
      return () => {
        clearInterval(beat);
        if (holder(file)?.pid === process.pid) fs.rmSync(file, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let touched: number;
      try {
        touched = fs.statSync(file).mtimeMs;
      } catch {
        // released meanwhile: taken on the next round
        continue;
      }
      const raw = read(file);
      const h = parse(raw);
      const why = stale(h, touched);
      if (!why) throw new LockError(h ? `the ${h.mode} is running on this profile (pid ${h.pid}, since ${h.since})` : `another process is taking ${file}`, h?.mode ?? "");
      // another process judging the same lock may have taken it over meanwhile: its lock is not the one judged
      if (read(file) !== raw) continue;
      log.info("lock", `taken over: ${why}`, { pid: h?.pid, mode: h?.mode });
      fs.rmSync(file, { force: true });
    }
  }
  throw new LockError(`lock ${file} could not be taken`);
}
