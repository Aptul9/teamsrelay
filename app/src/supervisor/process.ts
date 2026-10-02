import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

export type Command = { file: string; args: string[]; env?: Record<string, string>; cwd?: string; uid?: number; gid?: number };

export type Timing = { minDelayMs: number; maxDelayMs: number; stableMs: number; stopGraceMs: number };

const TIMING: Timing = { minDelayMs: 1000, maxDelayMs: 60_000, stableMs: 300_000, stopGraceMs: 10_000 };

// Delay before starting again a process that ran for upForMs: doubles with every exit that follows a short run,
// back to the minimum after a run of stableMs or longer.
export function restartDelay(upForMs: number, failures: number, t: Timing): { failures: number; delayMs: number } {
  const n = upForMs >= t.stableMs ? 1 : failures + 1;
  return { failures: n, delayMs: Math.min(t.maxDelayMs, t.minDelayMs * 2 ** (n - 1)) };
}

type Options = { log: (line: string) => void; output?: (line: string) => void; timing?: Timing };

// A process kept running until stop(), like a container with "restart: unless-stopped". It runs in its own
// process group, so the signals of stop() reach what it started too (the zygote and renderers of Chromium).
export class Supervised {
  restarts = 0;
  lastExit: string | null = null;
  private child: ChildProcess | null = null;
  private wanted = false;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private startedAt = 0;
  private readonly timing: Timing;

  constructor(
    readonly name: string,
    private readonly command: () => Command,
    private readonly opts: Options,
  ) {
    this.timing = opts.timing ?? TIMING;
  }

  get running() {
    return this.child !== null;
  }

  // running, or waiting to start again after an exit
  get active() {
    return this.wanted;
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  start() {
    this.wanted = true;
    if (!this.child && !this.timer) this.spawn();
  }

  async stop(): Promise<void> {
    this.wanted = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const child = this.child;
    if (!child) return;
    const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    signal(child, "SIGTERM");
    const kill = setTimeout(() => signal(child, "SIGKILL"), this.timing.stopGraceMs);
    await gone;
    clearTimeout(kill);
  }

  private spawn() {
    this.timer = null;
    const { file, args, env, cwd, uid, gid } = this.command();
    const output = this.opts.output;
    const child = spawn(file, args, {
      env: env as NodeJS.ProcessEnv | undefined,
      cwd,
      uid,
      gid,
      detached: true,
      windowsHide: true,
      stdio: output ? ["ignore", "pipe", "pipe"] : "ignore",
    });
    this.child = child;
    this.startedAt = Date.now();
    if (output) {
      for (const stream of [child.stdout, child.stderr]) {
        if (stream) readline.createInterface({ input: stream }).on("line", output);
      }
    }
    child.on("error", (e) => this.exited(child, e.message));
    child.on("exit", (code, sig) => this.exited(child, sig ? `signal ${sig}` : `code ${code}`));
  }

  // "exit" and "error" can both come for one process: only the first counts
  private exited(child: ChildProcess, how: string) {
    if (this.child !== child) return;
    this.child = null;
    this.lastExit = how;
    if (!this.wanted) return;
    const next = restartDelay(Date.now() - this.startedAt, this.failures, this.timing);
    this.failures = next.failures;
    this.opts.log(`${this.name} exited (${how}), starting again in ${next.delayMs / 1000} s`);
    this.timer = setTimeout(() => {
      this.restarts++;
      this.spawn();
    }, next.delayMs);
  }
}

function signal(child: ChildProcess, sig: NodeJS.Signals) {
  try {
    // the whole group; Windows has no process groups (tests only)
    if (process.platform === "win32" || !child.pid) child.kill(sig);
    else process.kill(-child.pid, sig);
  } catch {
    // already gone
  }
}
