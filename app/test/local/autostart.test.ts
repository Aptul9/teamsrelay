// The logon task of scripts/relay-autostart.ps1, as its dry run describes it (-DryRun registers nothing): a copy of
// the script in a folder whose path has an apostrophe, as a user folder may (C:\Users\O'Brien). -Resurrect, what the
// task runs, against a pm2.cmd that records its calls and answers "pm2 pid" from pid.txt.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../helpers";

const SCRIPT = path.resolve(__dirname, "../../scripts/relay-autostart.ps1");

// an app/ folder with the script and a pm2.cmd; the fake pm2 appends its arguments to calls.txt
function appFolder(folder: string, pid = ""): string {
  const root = path.join(tempDir(), folder);
  const bin = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, "scripts", "relay-autostart.ps1"));
  fs.writeFileSync(
    path.join(bin, "pm2.cmd"),
    ["@echo off", 'echo %*>>"%~dp0calls.txt"', 'if "%1"=="pid" type "%~dp0pid.txt"', ""].join("\r\n"),
  );
  fs.writeFileSync(path.join(bin, "pid.txt"), pid);
  return root;
}

function run(root: string, ...args: string[]) {
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "relay-autostart.ps1"), ...args],
    { encoding: "utf8" },
  );
}

// exit status, errors, and the "name: value" lines the dry run prints
function dryRun(folder: string): { status: number | null; stderr: string; task: Record<string, string> } {
  const r = run(appFolder(folder), "-DryRun");
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.includes(": "));
  const task = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(": ")), l.slice(l.indexOf(": ") + 2)]));
  return { status: r.status, stderr: r.stderr, task };
}

const calls = (root: string) =>
  fs.readFileSync(path.join(root, "node_modules", ".bin", "calls.txt"), "utf8").split(/\r?\n/).filter(Boolean);
const log = (root: string) => fs.readFileSync(path.join(root, "state", "autostart.log"), "utf8");

describe.runIf(process.platform === "win32")("logon task of the relay", () => {
  // the default priority of a task, 7, is below normal: the relay and its browser would run behind everything else
  it("runs at normal priority", () => {
    const { status, task } = dryRun("app");
    expect(status).toBe(0);
    expect(task.priority).toBe("5");
  }, 60_000);

  it("starts pm2 from a folder with an apostrophe in its path", () => {
    const { status, stderr, task } = dryRun("O'Brien app");
    expect(status, stderr).toBe(0);
    expect(task["parse errors"]).toBe("0");
    expect(task.command).toContain("O''Brien app");
    expect(task.command).toContain("-Resurrect");
  }, 60_000);

  // a start at logon that died is made good when the user comes back to the session
  it("runs again on unlock and RDP reconnect, and after a failed run", () => {
    const { status, stderr, task } = dryRun("app");
    expect(status, stderr).toBe(0);
    expect(task.triggers).toBe("logon, unlock, remote connect");
    expect(task["restart on failure"]).toBe("3");
  }, 60_000);
});

describe.runIf(process.platform === "win32")("relay start of the logon task", () => {
  it("leaves a relay that is already online alone", () => {
    const root = appFolder("app", "1234");
    const r = run(root, "-Resurrect", "-WaitSeconds", "0");
    expect(r.status, r.stderr).toBe(0);
    expect(calls(root)).toEqual(["pid teamsrelay"]);
    expect(log(root)).toContain("already online pid=1234");
  }, 60_000);

  it("leaves a relay stopped on purpose stopped", () => {
    const root = appFolder("app", "0");
    const r = run(root, "-Resurrect", "-WaitSeconds", "0");
    expect(r.status, r.stderr).toBe(0);
    expect(calls(root)).toEqual(["pid teamsrelay"]);
    expect(log(root)).toContain("left alone");
  }, 60_000);

  it("tries resurrect again while the relay does not come up, and says so", () => {
    const root = appFolder("app");
    const r = run(root, "-Resurrect", "-Attempts", "2", "-WaitSeconds", "0");
    expect(r.status).toBe(1);
    expect(calls(root).filter((c) => c === "resurrect")).toHaveLength(2);
    expect(log(root)).toContain("resurrect attempt=2");
    expect(log(root)).toContain("not online after 2 attempts");
  }, 60_000);
});
