// The bundle of the relay as pm2 runs it (IPC channel, shutdown message), kept before its browser: a sign-in lock held
// by this test process makes it wait, and STATE_DIR has no API token, so it never reaches the browser launch.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../helpers";

const APP = path.resolve(__dirname, "../..");
let bundle = "";
let child: ChildProcess | null = null;

beforeAll(async () => {
  bundle = path.join(tempDir("teamsrelay-relay-process-"), "relay.cjs");
  await build({
    absWorkingDir: APP,
    entryPoints: ["src/local/main.ts"],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    external: ["playwright-core", "better-sqlite3"],
    outfile: bundle,
    logLevel: "warning",
  });
});

afterEach(() => {
  child?.kill();
  child = null;
});

// the relay waiting for a sign-in that this process holds; its output, and its exit
function waitingRelay() {
  const state = tempDir();
  fs.writeFileSync(path.join(state, "relay.lock"), JSON.stringify({ pid: process.pid, mode: "login", since: new Date().toISOString() }));
  const lines: string[] = [];
  const p = spawn(process.execPath, [bundle], {
    cwd: state,
    env: { ...process.env, NODE_PATH: path.join(APP, "node_modules"), STATE_DIR: state },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  for (const s of [p.stdout, p.stderr]) s?.on("data", (d) => lines.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const exited = new Promise<number | null>((resolve) => p.once("exit", (code) => resolve(code)));
  child = p;
  return { p, lines, exited, state };
}

async function until(check: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("relay process under pm2", () => {
  it("stops at once on the shutdown message of pm2 while it waits for the sign-in", async () => {
    const r = waitingRelay();
    await until(() => r.lines.some((l) => l.includes("waiting for the sign-in to finish")), 15_000, "the waiting line");
    const t0 = Date.now();
    r.p.send("shutdown");
    const code = await Promise.race([r.exited, new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), 5000))]);
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.lines).toContain("relay: stopping");
    // the sign-in keeps its lock
    expect(JSON.parse(fs.readFileSync(path.join(r.state, "relay.lock"), "utf8")).pid).toBe(process.pid);
  }, 30_000);
});
