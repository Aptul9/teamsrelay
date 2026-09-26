import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountError, Accounts, agentCommand, browserCommand, type AccountsConfig, type ProcessLike } from "@/supervisor/accounts";
import { tempDir } from "../helpers";

let cfg: AccountsConfig;
let calls: string[];

beforeEach(() => {
  const root = tempDir();
  cfg = {
    profilesDir: path.join(root, "profiles"),
    dataDir: "/root/data",
    vapidDir: "/root/vapid",
    slotCount: 4,
    uid: 1000,
    gid: 1000,
    chromium: "/usr/bin/chromium",
    agentScript: "/app/agent.cjs",
    node: "/usr/local/bin/node",
    cdpBasePort: 9221,
    session: { XDG_RUNTIME_DIR: "/config/.XDG", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    browserEnv: { TZ: "Europe/Rome", LANG: "en_US.UTF-8" },
    agentEnv: { TZ: "Europe/Rome", VAPID_SUBJECT: "mailto:me@example.com", NTFY_ENABLED: "0" },
    wlrctl: "wlrctl",
  };
  fs.mkdirSync(cfg.profilesDir);
  calls = [];
});

// Stand-in for a supervised process: records the calls, "stop" can take its time
function fakeProcess(name: string, stopMs = 0): ProcessLike {
  let wanted = false;
  return {
    name,
    restarts: 0,
    lastExit: null,
    get running() {
      return wanted;
    },
    get active() {
      return wanted;
    },
    get pid() {
      return wanted ? 4242 : null;
    },
    start() {
      calls.push(`start ${name}`);
      wanted = true;
    },
    async stop() {
      calls.push(`stop ${name}`);
      await new Promise((r) => setTimeout(r, stopMs));
      wanted = false;
    },
  };
}

function accounts(opts: { stopMs?: number; focused?: number[] } = {}) {
  return new Accounts(cfg, {
    log: () => undefined,
    process: (name) => fakeProcess(name, opts.stopMs),
    focus: async (n) => {
      opts.focused?.push(n);
      return true;
    },
  });
}

function profile(n: number, ...files: string[]) {
  const dir = path.join(cfg.profilesDir, String(n));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), "x");
  }
  return dir;
}

describe("browserCommand", () => {
  it("runs Chromium as the desktop user, with the profile of the account and its own DevTools port", () => {
    const c = browserCommand(2, cfg);

    expect(c.file).toBe("/usr/bin/chromium");
    expect(c.uid).toBe(1000);
    expect(c.gid).toBe(1000);
    expect(c.cwd).toBe(path.join(cfg.profilesDir, "2"));
    expect(c.env).toMatchObject({
      HOME: path.join(cfg.profilesDir, "2"),
      XDG_RUNTIME_DIR: "/config/.XDG",
      WAYLAND_DISPLAY: "wayland-0",
      DISPLAY: ":0",
      TZ: "Europe/Rome",
      LANG: "en_US.UTF-8",
    });
    expect(c.args).toContain("--remote-debugging-port=9223");
    expect(c.args).toContain("--class=teamsrelay-2");
    expect(c.args).toContain("--ozone-platform=wayland");
    expect(c.args).toContain("--disable-backgrounding-occluded-windows");
    expect(c.args.at(-1)).toBe("https://teams.microsoft.com/");
  });

  it("keeps the Chromium sandbox and the DevTools origin check", () => {
    const args = browserCommand(1, cfg).args.join(" ");
    expect(args).not.toContain("--no-sandbox");
    expect(args).not.toContain("--remote-allow-origins");
  });
});

describe("agentCommand", () => {
  it("runs the agent of the account against the DevTools port of its browser", () => {
    const c = agentCommand(2, cfg);

    expect(c.file).toBe("/usr/local/bin/node");
    expect(c.args).toEqual(["/app/agent.cjs"]);
    expect(c.uid).toBeUndefined();
    expect(c.env).toMatchObject({
      ACCOUNT: "2",
      CDP: "http://127.0.0.1:9223",
      DB_PATH: "/root/data/2/messages.db",
      APP_DB: "/root/data/app.db",
      VAPID_PRIVATE: "/root/vapid/private_key.pem",
      VAPID_APPKEY: "/root/vapid/appkey.txt",
      VAPID_SUBJECT: "mailto:me@example.com",
      NTFY_ENABLED: "0",
      TZ: "Europe/Rome",
    });
  });
});

describe("Accounts", () => {
  it("starts the browser, then the agent, and creates the profile directory", async () => {
    await accounts().start(1);

    expect(calls).toEqual(["start browser-1", "start agent-1"]);
    expect(fs.existsSync(path.join(cfg.profilesDir, "1"))).toBe(true);
  });

  it("removes the lock files a browser of another host left in the profile, and nothing else", async () => {
    const dir = profile(2, ".config/chromium/SingletonLock", ".config/chromium/SingletonSocket", ".config/chromium/SingletonCookie", ".config/chromium/Default/Cookies");

    await accounts().start(2);

    expect(fs.readdirSync(path.join(dir, ".config/chromium"))).toEqual(["Default"]);
  });

  it("stops the agent before the browser", async () => {
    const a = accounts();
    await a.start(1);
    calls = [];

    await a.stop(1);

    expect(calls).toEqual(["stop agent-1", "stop browser-1"]);
  });

  it("runs the requests of one account one at a time", async () => {
    const a = accounts({ stopMs: 100 });
    await a.start(1);
    calls = [];

    await Promise.all([a.stop(1), a.start(1)]);

    expect(calls).toEqual(["stop agent-1", "stop browser-1", "start browser-1", "start agent-1"]);
  });

  it("refuses accounts outside 1..slotCount", async () => {
    const a = accounts();
    for (const n of [0, 5, 1.5, Number.NaN]) {
      await expect(a.start(n)).rejects.toMatchObject({ status: 404 });
    }
    expect(calls).toEqual([]);
  });

  it("empties the profile of a stopped account and keeps its directory", async () => {
    const dir = profile(3, ".config/chromium/Default/Cookies", ".cache/chromium/x", "top.txt");

    await accounts().wipe(3);

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("wipes an account that never had a profile", async () => {
    await expect(accounts().wipe(4)).resolves.toBeUndefined();
  });

  it("refuses to wipe a running account", async () => {
    const dir = profile(2, "top.txt");
    const a = accounts();
    await a.start(2);

    await expect(a.wipe(2)).rejects.toBeInstanceOf(AccountError);
    await expect(a.wipe(2)).rejects.toMatchObject({ status: 409 });
    expect(fs.existsSync(path.join(dir, "top.txt"))).toBe(true);
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)("reports what it could not delete", async () => {
    const dir = profile(1, "locked/file", "free.txt");
    fs.chmodSync(path.join(dir, "locked"), 0o555);
    try {
      await expect(accounts().wipe(1)).rejects.toThrow(/not wiped, left: locked/);
      expect(fs.existsSync(path.join(dir, "free.txt"))).toBe(false);
    } finally {
      fs.chmodSync(path.join(dir, "locked"), 0o755);
    }
  });

  it("brings the window of a running account to the front, and does nothing for a stopped one", async () => {
    const focused: number[] = [];
    const a = accounts({ focused });

    expect(await a.show(1)).toBe(false);
    await a.start(1);
    expect(await a.show(1)).toBe(true);
    expect(focused).toEqual([1]);
  });

  it("lists the accounts it runs", async () => {
    const a = accounts();
    await a.start(2);

    expect(a.status()).toEqual([
      {
        account: 2,
        browser: { running: true, pid: 4242, restarts: 0, lastExit: null },
        agent: { running: true, pid: 4242, restarts: 0, lastExit: null },
      },
    ]);
  });

  it("stops every account", async () => {
    const a = accounts();
    await a.start(1);
    await a.start(2);
    calls = [];

    await a.stopAll();

    expect(calls.sort()).toEqual(["stop agent-1", "stop agent-2", "stop browser-1", "stop browser-2"]);
    expect(a.status().every((s) => !s.browser.running && !s.agent.running)).toBe(true);
  });
});
