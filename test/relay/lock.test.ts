import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, LockError } from "@/relay/lock";
import { tempDir } from "../helpers";

const lockIn = () => path.join(tempDir(), "state", "relay.lock");
// pid of a process that ran and is gone
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid as number;

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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // the parent of this test process is alive for the whole test
    fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, mode: "login", since: "2026-09-26T19:00:00.000Z" }));
    expect(() => acquireLock(file, "relay")).toThrow(LockError);
    expect(() => acquireLock(file, "relay")).toThrow(/the login is running on this profile/);
    let refused: unknown;
    try {
      acquireLock(file, "relay");
    } catch (e) {
      refused = e;
    }
    expect((refused as LockError).heldBy).toBe("login");
  });

  it("takes over the lock of a process that is gone, or a broken one", () => {
    for (const content of [JSON.stringify({ pid: deadPid(), mode: "relay", since: "" }), "{broken"]) {
      const file = lockIn();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
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
