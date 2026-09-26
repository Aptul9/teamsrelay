import { afterEach, describe, expect, it } from "vitest";
import { restartDelay, Supervised, type Command, type Timing } from "@/supervisor/process";

const node = (code: string): Command => ({ file: process.execPath, args: ["-e", code] });
const fast: Timing = { minDelayMs: 50, maxDelayMs: 400, stableMs: 60_000, stopGraceMs: 500 };
const posix = process.platform !== "win32";

async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let started: Supervised[] = [];
afterEach(async () => {
  await Promise.all(started.map((p) => p.stop()));
  started = [];
});

function supervised(cmd: Command, extra: { timing?: Timing; output?: (line: string) => void } = {}) {
  const p = new Supervised("test", () => cmd, { log: () => undefined, timing: fast, ...extra });
  started.push(p);
  return p;
}

describe("restartDelay", () => {
  const t: Timing = { minDelayMs: 1000, maxDelayMs: 60_000, stableMs: 300_000, stopGraceMs: 10_000 };

  it("doubles while the process keeps failing soon after its start, up to the maximum", () => {
    let failures = 0;
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = restartDelay(5_000, failures, t);
      failures = r.failures;
      delays.push(r.delayMs);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  it("starts again from the minimum after a run of stableMs or longer", () => {
    expect(restartDelay(300_000, 6, t)).toEqual({ failures: 1, delayMs: 1000 });
  });
});

describe("Supervised", () => {
  it("starts the process again after it exits", async () => {
    const p = supervised(node("process.exit(3)"));
    p.start();
    await until(() => p.restarts >= 2);
    expect(p.lastExit).toBe("code 3");
  });

  it("stops the process and does not start it again", async () => {
    const p = supervised(node("setInterval(() => {}, 1000)"));
    p.start();
    expect(p.running).toBe(true);

    await p.stop();
    expect(p.running).toBe(false);
    await wait(300);
    expect(p.running).toBe(false);
    expect(p.restarts).toBe(0);
  });

  it("cancels a restart that is still waiting for its delay", async () => {
    const p = supervised(node("process.exit(1)"), { timing: { ...fast, minDelayMs: 300 } });
    p.start();
    await until(() => p.lastExit !== null);

    await p.stop();
    await wait(600);
    expect(p.running).toBe(false);
    expect(p.restarts).toBe(0);
  });

  it("retries a program that cannot be started", async () => {
    const p = supervised({ file: "/nonexistent/teamsrelay-test-binary", args: [] });
    p.start();
    await until(() => p.restarts >= 1);
    expect(p.lastExit).toMatch(/ENOENT/);
  });

  it("passes the output lines of the process on", async () => {
    const lines: string[] = [];
    const p = supervised(node("console.log('one'); console.error('two'); setInterval(() => {}, 1000)"), { output: (l) => lines.push(l) });
    p.start();
    await until(() => lines.length === 2);
    expect(lines.sort()).toEqual(["one", "two"]);
  });

  it.runIf(posix)("kills a process that ignores SIGTERM once the grace is over", async () => {
    const lines: string[] = [];
    const p = supervised(node("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"), { output: (l) => lines.push(l) });
    p.start();
    await until(() => lines.includes("ready"));

    const t0 = Date.now();
    await p.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    expect(p.lastExit).toBe("signal SIGKILL");
  });

  it.runIf(posix)("stops the children of the process with it", async () => {
    const lines: string[] = [];
    const parent = "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log('child ' + c.pid); setInterval(() => {}, 1000)";
    const p = supervised(node(parent), { output: (l) => lines.push(l) });
    p.start();
    await until(() => lines.some((l) => l.startsWith("child ")));
    const child = Number(lines.find((l) => l.startsWith("child "))!.slice(6));

    await p.stop();
    const alive = () => {
      try {
        process.kill(child, 0);
        return true;
      } catch {
        return false;
      }
    };
    await until(() => !alive(), 3000);
  });
});
