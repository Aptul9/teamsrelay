// The supervisor bundle as a process, with stand-ins for Chromium and the agent: control socket, start once
// the desktop is up, command lines and environments, status subcommand, clean stop on SIGTERM. POSIX only:
// the processes of the accounts run under a uid and in their own process groups.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../helpers";

const APP = path.resolve(__dirname, "../..");
const posix = process.platform !== "win32";
let dir = "";
let bundle = "";
let env: Record<string, string> = {};
let supervisor: ChildProcess | null = null;
const lines: string[] = [];

async function until<T>(check: () => T | null | undefined | false, timeout: number, what: string): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; supervisor log:\n${lines.slice(-15).join("\n")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function request(method: string, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: env.CONTROL_SOCKET, method, path: url }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readJson = (file: string) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);

beforeAll(async () => {
  if (!posix) return;
  dir = tempDir();
  bundle = path.join(dir, "supervisor.cjs");
  await build({ entryPoints: [path.join(APP, "src/supervisor/main.ts")], bundle: true, platform: "node", target: "node24", format: "cjs", outfile: bundle, logLevel: "warning" });
  // stand-in for Chromium: leaves its arguments in its HOME, the profile of the account
  const chromium = path.join(dir, "chromium");
  fs.writeFileSync(
    chromium,
    `#!/bin/sh\nexec "${process.execPath}" -e "require('fs').writeFileSync(process.env.HOME + '/browser.json', JSON.stringify({ args: process.argv.slice(1), pid: process.pid })); setInterval(() => {}, 1000)" -- "$@"\n`,
  );
  fs.chmodSync(chromium, 0o755);
  const agent = path.join(dir, "agent.cjs");
  fs.writeFileSync(
    agent,
    "require('fs').writeFileSync(process.env.APP_DB + '.agent-' + process.env.ACCOUNT + '.json', JSON.stringify({ cdp: process.env.CDP, db: process.env.DB_PATH, pid: process.pid })); console.log('agent: start'); setInterval(() => {}, 1000)",
  );
  fs.mkdirSync(path.join(dir, "data"));
  fs.mkdirSync(path.join(dir, "xdg"));
  env = {
    PATH: process.env.PATH ?? "",
    CONTROL_SOCKET: path.join(dir, "control.sock"),
    PROFILES_DIR: path.join(dir, "profiles"),
    DATA_DIR: path.join(dir, "data"),
    VAPID_DIR: path.join(dir, "vapid"),
    XDG_RUNTIME_DIR: path.join(dir, "xdg"),
    PUID: String(process.getuid?.()),
    PGID: String(process.getgid?.()),
    CHROMIUM: chromium,
    AGENT_SCRIPT: agent,
    SLOT_COUNT: "2",
    TZ: "Europe/Rome",
  };
  supervisor = spawn(process.execPath, [bundle], { env: env as NodeJS.ProcessEnv });
  for (const stream of [supervisor.stdout, supervisor.stderr]) stream?.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
  supervisor.on("exit", (code, signal) => lines.push(`[exit] code=${code} signal=${signal}`));
  await until(() => fs.existsSync(env.CONTROL_SOCKET), 10_000, "the control socket");
}, 60_000);

afterAll(() => {
  if (supervisor && supervisor.exitCode === null) supervisor.kill("SIGKILL");
});

describe.runIf(posix)("supervisor process", () => {
  it("starts the browser and the agent of an account once the desktop is up", async () => {
    const reply = request("POST", "/accounts/1/start");
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(path.join(dir, "profiles", "1", "browser.json"))).toBe(false);

    fs.writeFileSync(path.join(env.XDG_RUNTIME_DIR, "wayland-0"), "");

    expect((await reply).status).toBe(204);
    const browser = await until(() => readJson(path.join(dir, "profiles", "1", "browser.json")), 10_000, "the browser");
    expect(browser.args).toContain("--remote-debugging-port=9222");
    expect(browser.args).toContain("--class=teamsrelay-1");
    const agent = await until(() => readJson(path.join(dir, "data", "app.db.agent-1.json")), 10_000, "the agent");
    expect(agent).toMatchObject({ cdp: "http://127.0.0.1:9222", db: path.join(dir, "data", "1", "messages.db") });
    await until(() => lines.includes("[1] agent: start"), 10_000, "the agent log line");
  });

  it("reports the accounts through the status subcommand", async () => {
    const out = await new Promise<string>((resolve, reject) =>
      execFile(process.execPath, [bundle, "status"], { env: env as NodeJS.ProcessEnv }, (err: Error | null, stdout: string) => (err ? reject(err) : resolve(stdout))),
    );
    expect(JSON.parse(out)).toEqual([expect.objectContaining({ account: 1, browser: expect.objectContaining({ running: true }), agent: expect.objectContaining({ running: true }) })]);
  });

  it("stops every account and exits on SIGTERM", async () => {
    const browser = readJson(path.join(dir, "profiles", "1", "browser.json"));
    const agent = readJson(path.join(dir, "data", "app.db.agent-1.json"));

    supervisor?.kill("SIGTERM");

    await until(() => lines.find((l) => l.startsWith("[exit]")), 30_000, "the supervisor exit");
    expect(lines).toContain("[exit] code=0 signal=null");
    await until(() => !alive(browser.pid) && !alive(agent.pid), 5000, "browser and agent gone");
  }, 40_000);
});
