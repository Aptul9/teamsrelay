import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLock, LockError } from "@/local/lock";
import { tempDir } from "../helpers";

const lockIn = () => path.join(tempDir(), "state", "relay.lock");
// pid of a process that ran and is gone
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid as number;
const MINUTE = 60_000;
const bootedAt = () => Date.now() - os.uptime() * 1000;

// A lock left by another process: its holder (the parent of this test process is alive for the whole test), when it
// was written, and when its file last changed
function leftBy(file: string, holder: { pid?: number; mode?: string; since?: number | string }, touchedAgo = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const since = typeof holder.since === "number" ? new Date(holder.since).toISOString() : (holder.since ?? new Date().toISOString());
  fs.writeFileSync(file, JSON.stringify({ pid: holder.pid ?? process.ppid, mode: holder.mode ?? "relay", since }));
  const t = new Date(Date.now() - touchedAgo);
  fs.utimesSync(file, t, t);
}

function refusal(file: string, mode: "relay" | "login" = "relay"): LockError | null {
  try {
    acquireLock(file, mode)();
    return null;
  } catch (e) {
    return e as LockError;
  }
}

describe("profile lock", () => {
  it("names its holder and goes away on release", () => {
    const file = lockIn();
    const release = acquireLock(file, "relay");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ pid: process.pid, mode: "relay" });
    release();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses while another process holds it", () => {
    const file = lockIn();
    leftBy(file, { mode: "login" });
    expect(() => acquireLock(file, "relay")).toThrow(LockError);
    expect(() => acquireLock(file, "relay")).toThrow(/the login is running on this profile/);
    expect(refusal(file)?.heldBy).toBe("login");
  });

  it("takes over the lock of a process that is gone, or one broken for a while", () => {
    const file = lockIn();
    for (const make of [() => leftBy(file, { pid: deadPid() }), () => (fs.writeFileSync(file, "{broken"), fs.utimesSync(file, new Date(Date.now() - MINUTE), new Date(Date.now() - MINUTE)))]) {
      make();
      const release = acquireLock(file, "login");
      expect(JSON.parse(fs.readFileSync(file, "utf8")).mode).toBe("login");
      release();
    }
  });

  it("leaves alone a lock another process took after it", () => {
    const file = lockIn();
    const release = acquireLock(file, "relay");
    fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, mode: "login", since: "" }));
    release();
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("lock left behind", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // after a reboot the pid of the old relay may belong to any process: the relay would never start again
  it("is taken over when written before the machine started, whoever has its pid now", () => {
    const file = lockIn();
    leftBy(file, { since: bootedAt() - 10 * MINUTE });
    expect(refusal(file)).toBeNull();
  });

  // the relay waits for a sign-in lock: one the sign-in forgot would keep it waiting for ever. The machine is up for
  // a day here, so that the lock is from after it started (a CI runner may be up for minutes only).
  it("is taken over when it is a sign-in lock older than a sign-in can last", () => {
    vi.spyOn(os, "uptime").mockReturnValue(24 * 3600);
    const file = lockIn();
    leftBy(file, { mode: "login", since: Date.now() - 19 * MINUTE });
    expect(refusal(file)?.heldBy).toBe("login");
    leftBy(file, { mode: "login", since: Date.now() - 25 * MINUTE });
    expect(refusal(file)).toBeNull();
  });

  it("is taken over when its holder stopped keeping it up to date", () => {
    const file = lockIn();
    leftBy(file, {}, 3 * MINUTE);
    expect(refusal(file)).toBeNull();
  });

  // two processes judge the same stale lock: the one that takes it over first keeps it
  it("leaves alone a lock another process took over while this one judged the old one", () => {
    const file = lockIn();
    leftBy(file, { pid: deadPid() });
    const real = fs.readFileSync;
    let swapped = false;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      const content = real(p, o as BufferEncoding);
      if (!swapped && p === file) {
        // the other process takes the stale lock over right after this one read it
        swapped = true;
        fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, mode: "login", since: new Date().toISOString() }));
      }
      return content;
    }) as typeof fs.readFileSync);
    expect(refusal(file)?.heldBy).toBe("login");
    vi.restoreAllMocks();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ pid: process.ppid, mode: "login" });
  });

  it("holds while its holder keeps it up to date", () => {
    const file = lockIn();
    leftBy(file, {}, 20_000);
    expect(refusal(file)?.message).toMatch(/the relay is running on this profile/);
  });

  it("holds when it has no content yet: the process that created it is still writing it", () => {
    const file = lockIn();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    expect(refusal(file)).toBeInstanceOf(LockError);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("is kept up to date by its holder", async () => {
    const file = lockIn();
    const release = acquireLock(file, "relay", 50);
    const old = new Date(Date.now() - 3 * MINUTE);
    fs.utimesSync(file, old, old);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(Date.now() - fs.statSync(file).mtimeMs).toBeLessThan(MINUTE);
    release();
  });
});
