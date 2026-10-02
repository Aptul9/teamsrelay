// The command runner behind cmdapi: run one command, report everything needed to judge the outcome. A non-zero exit
// is a result, not an error; a command past its deadline is killed with its children; output is capped so one command
// cannot eat the response or the memory. Programs are run with `args` (no shell) so these tests hold on every platform.
import { describe, expect, it } from "vitest";
import { run, shellArgv } from "@/fleet/cmdapi/runner";

const node = process.execPath;

describe("cmdapi runner", () => {
  it("runs a program and returns its stdout and exit 0", async () => {
    const r = await run({ args: [node, "-e", "process.stdout.write('hello')"] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello");
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it("reports a non-zero exit code instead of throwing", async () => {
    const r = await run({ args: [node, "-e", "process.stderr.write('nope'); process.exit(3)"] });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toBe("nope");
  });

  it("caps each stream at maxOutput and flags it truncated", async () => {
    const r = await run({ args: [node, "-e", "process.stdout.write('x'.repeat(100000))"], maxOutput: 1000 });
    expect(r.stdout.length).toBe(1000);
    expect(r.truncated).toBe(true);
  });

  it("kills a command past its timeout and flags it, without waiting it out", async () => {
    const r = await run({ args: [node, "-e", "setInterval(() => {}, 1000)"], timeout: 0.5 });
    expect(r.timedOut).toBe(true);
    // killed on the deadline plus the drain grace, nowhere near the 1000 s the process would otherwise run
    expect(r.durationMs).toBeLessThan(8000);
  });

  it("runs a string command through a shell", async () => {
    const r = await run({ command: "echo fleettest" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("fleettest");
  });

  it("rejects a call that passes neither command nor args, or both", async () => {
    await expect(run({})).rejects.toThrow();
    await expect(run({ command: "echo hi", args: [node, "-e", ""] })).rejects.toThrow();
  });
});

describe("shellArgv", () => {
  it("wraps PowerShell with -NoProfile -NonInteractive -Command", () => {
    expect(shellArgv("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "Get-Date")).toEqual([
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-Date",
    ]);
    expect(shellArgv("pwsh", "echo hi")).toEqual(["pwsh", "-NoProfile", "-NonInteractive", "-Command", "echo hi"]);
  });

  it("wraps cmd.exe with /c", () => {
    expect(shellArgv("C:\\Windows\\System32\\cmd.exe", "echo %USERNAME%")).toEqual(["C:\\Windows\\System32\\cmd.exe", "/c", "echo %USERNAME%"]);
  });

  it("wraps a POSIX shell with -c", () => {
    expect(shellArgv("/bin/sh", "echo hi")).toEqual(["/bin/sh", "-c", "echo hi"]);
    expect(shellArgv("/bin/bash", "echo hi")).toEqual(["/bin/bash", "-c", "echo hi"]);
  });
});
