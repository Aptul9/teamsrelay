// The logon task of scripts/relay-autostart.ps1, as its dry run describes it (-DryRun registers nothing): a copy of
// the script in a folder whose path has an apostrophe, as a user folder may (C:\Users\O'Brien).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../helpers";

const SCRIPT = path.resolve(__dirname, "../../scripts/relay-autostart.ps1");

// exit status, errors, and the "name: value" lines the dry run prints
function dryRun(folder: string): { status: number | null; stderr: string; task: Record<string, string> } {
  const root = path.join(tempDir(), folder);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, "scripts", "relay-autostart.ps1"));
  fs.writeFileSync(path.join(root, "node_modules", ".bin", "pm2.cmd"), "");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "relay-autostart.ps1"), "-DryRun"], { encoding: "utf8" });
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.includes(": "));
  const task = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(": ")), l.slice(l.indexOf(": ") + 2)]));
  return { status: r.status, stderr: r.stderr, task };
}

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
  }, 60_000);
});
