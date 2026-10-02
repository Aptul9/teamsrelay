// Run one command and report everything needed to judge the outcome. Three things make this more than a one-line
// spawn: a command that never returns must die on a deadline and take its children with it (not just the shell that
// spawned them); output must be capped, or one command's output becomes the whole response and eats the memory; and
// partial output from a killed command is still evidence, so it is kept rather than dropped.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const POSIX = process.platform !== "win32";

// Time given to the pipes after a kill. A child that inherited stdout can hold it open past its parent's death; this
// is the bounded fallback so the reader cannot spin forever.
const DRAIN_GRACE_MS = 5000;

export interface RunOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  // seconds before the command is killed with its whole tree
  timeout?: number;
  // bytes kept per stream; the rest is dropped and flagged
  maxOutput?: number;
  // the shell a string command runs through; the platform default without one
  shell?: string;
}

export interface Result {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}


// Find an executable on PATH. On Windows the name may be given without its extension, so PATHEXT is tried.
function whichSync(name: string): string | null {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
        // next
      }
    }
  }
  return null;
}

// The interpreter a bare string command runs through when none is named: Windows prefers PowerShell and falls back to
// cmd.exe if neither PowerShell is on PATH; POSIX uses /bin/sh. Always a real path or name, so the shell is a decided
// fact by the time a command runs.
export function defaultShell(): string {
  if (process.platform === "win32") {
    for (const name of ["pwsh", "powershell"]) {
      const found = whichSync(name);
      if (found) return found;
    }
    return process.env.COMSPEC || "cmd.exe";
  }
  return "/bin/sh";
}

// Wrap a string command in its interpreter, explicitly: every shell family gets an argv built here rather than relying
// on spawn's own shell handling, whose Windows path only reaches cmd.exe. This makes PowerShell the Windows default and
// lets any shell be named on either platform.
export function shellArgv(shell: string, command: string): string[] {
  const family = shellFamily(shell);
  if (family === "powershell") return [shell, "-NoProfile", "-NonInteractive", "-Command", command];
  if (family === "cmd") return [shell, "/c", command];
  return [shell, "-c", command];
}

// The family of a shell by its file name. Split on both separators: a Windows shell path must still be recognized when
// this runs on a POSIX host (tests), where path.basename would not treat a backslash as a separator.
export function shellFamily(shell: string): "powershell" | "cmd" | "posix" {
  const name = (shell.split(/[\\/]/).pop() ?? shell).toLowerCase();
  if (name.includes("pwsh") || name.includes("powershell")) return "powershell";
  if (name === "cmd" || name === "cmd.exe") return "cmd";
  return "posix";
}

function terminate(pid: number): void {
  // A string command runs through a shell, so what must die is a whole tree, not just the shell. POSIX kills the
  // process group; Windows has no process groups here, so taskkill /T walks and kills the children too.
  if (POSIX) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // fall back to the lone process below
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    return;
  }
  spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
}

interface Sink {
  ended: Promise<void>;
  text(): string;
  truncated(): boolean;
  cancel(): void;
}

function drain(stream: NodeJS.ReadableStream | null, limit: number): Sink {
  const chunks: Buffer[] = [];
  let size = 0;
  let cut = false;
  if (!stream) return { ended: Promise.resolve(), text: () => "", truncated: () => false, cancel: () => undefined };
  const onData = (buf: Buffer) => {
    if (size >= limit) {
      cut = true;
      return;
    }
    const room = limit - size;
    if (buf.length > room) {
      chunks.push(buf.subarray(0, room));
      size = limit;
      cut = true;
    } else {
      chunks.push(buf);
      size += buf.length;
    }
  };
  stream.on("data", onData);
  const ended = new Promise<void>((resolve) => stream.once("end", resolve));
  return {
    ended,
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => cut,
    cancel: () => {
      stream.removeListener("data", onData);
    },
  };
}

export async function run(opts: RunOptions): Promise<Result> {
  const hasCommand = typeof opts.command === "string";
  const hasArgs = Array.isArray(opts.args);
  if (hasCommand === hasArgs) throw new Error("pass exactly one of command or args");
  if (hasArgs && opts.args!.length === 0) throw new Error("args is empty");

  const timeout = opts.timeout ?? 60;
  const maxOutput = opts.maxOutput ?? 1_000_000;
  const environment = { ...process.env, ...(opts.env ?? {}) };

  let argv: string[];
  let shown: string;
  if (hasArgs) {
    argv = opts.args!;
    shown = argv.join(" ");
  } else {
    const shell = opts.shell || defaultShell();
    argv = shellArgv(shell, opts.command!);
    shown = opts.command!;
  }

  const started = Date.now();
  const child = spawn(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: POSIX,
  });

  const out = drain(child.stdout, maxOutput);
  const err = drain(child.stderr, maxOutput);

  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", (e) => reject(e));
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) terminate(child.pid);
  }, timeout * 1000);

  let exitCode: number | null;
  try {
    exitCode = await exit;
  } finally {
    clearTimeout(timer);
  }

  // The process has exited; its pipes may still be held open by a child that inherited them. Wait for them, but only
  // up to the grace, then take what has been read so far.
  await Promise.race([Promise.all([out.ended, err.ended]), sleep(DRAIN_GRACE_MS)]);
  out.cancel();
  err.cancel();

  return {
    command: shown,
    exitCode,
    stdout: out.text(),
    stderr: err.text(),
    durationMs: Date.now() - started,
    timedOut,
    truncated: out.truncated() || err.truncated(),
  };
}
