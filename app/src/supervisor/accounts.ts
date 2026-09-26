import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { format } from "../agent/log";
import { Supervised, type Command } from "./process";

export type AccountsConfig = {
  profilesDir: string;
  dataDir: string;
  vapidDir: string;
  slotCount: number;
  // owner of the profiles and of the desktop session (PUID/PGID of the image)
  uid: number;
  gid: number;
  chromium: string;
  agentScript: string;
  node: string;
  // DevTools of account N listen on 127.0.0.1:(cdpBasePort + N)
  cdpBasePort: number;
  // Wayland session of the desktop, where the browser windows open
  session: Record<string, string>;
  browserEnv: Record<string, string>;
  agentEnv: Record<string, string>;
  wlrctl: string;
};

export class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ProcessLike {
  readonly name: string;
  readonly running: boolean;
  readonly active: boolean;
  readonly pid: number | null;
  restarts: number;
  lastExit: string | null;
  start(): void;
  stop(): Promise<void>;
}

type ProcessState = { running: boolean; pid: number | null; restarts: number; lastExit: string | null };
export type AccountStatus = { account: number; browser: ProcessState; agent: ProcessState };

const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// Stale locks of a Chromium that ran elsewhere (the chromium-N container of earlier releases, a container
// before a restart): Chromium refuses a profile whose lock names another host.
const LOCKS = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

export const profileDir = (n: number, cfg: AccountsConfig) => path.join(cfg.profilesDir, String(n));

// HOME is the profile directory, as /config was in the chromium-N container of earlier releases: the Chromium
// profile stays at $HOME/.config/chromium and the accounts signed in there stay signed in.
export function browserCommand(n: number, cfg: AccountsConfig): Command {
  const home = profileDir(n, cfg);
  return {
    file: cfg.chromium,
    args: [
      "--ozone-platform=wayland",
      `--class=teamsrelay-${n}`,
      `--remote-debugging-port=${cfg.cdpBasePort + n}`,
      "--password-store=basic",
      "--simulate-outdated-no-au=Tue, 31 Dec 2099 23:59:59 GMT",
      "--no-first-run",
      "--no-default-browser-check",
      "--start-maximized",
      // the windows cover each other on the one desktop: a covered window keeps running at full speed
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "https://teams.microsoft.com/",
    ],
    env: { PATH, HOME: home, ...cfg.session, ...cfg.browserEnv },
    cwd: home,
    uid: cfg.uid,
    gid: cfg.gid,
  };
}

// The agent runs as root: data/ and vapid/ are under /root, out of reach of the browsers
export function agentCommand(n: number, cfg: AccountsConfig): Command {
  const { join } = path.posix;
  return {
    file: cfg.node,
    args: [cfg.agentScript],
    env: {
      PATH,
      HOME: "/root",
      NODE_ENV: "production",
      ...cfg.agentEnv,
      ACCOUNT: String(n),
      CDP: `http://127.0.0.1:${cfg.cdpBasePort + n}`,
      DB_PATH: join(cfg.dataDir, String(n), "messages.db"),
      APP_DB: join(cfg.dataDir, "app.db"),
      VAPID_PRIVATE: join(cfg.vapidDir, "private_key.pem"),
      VAPID_APPKEY: join(cfg.vapidDir, "appkey.txt"),
    },
  };
}

type Deps = {
  log: (line: string) => void;
  process?: (name: string, command: () => Command, output?: (line: string) => void) => ProcessLike;
  // brings the window of account N to the front of the desktop
  focus?: (n: number) => Promise<boolean>;
};

type Account = { browser: ProcessLike; agent: ProcessLike };

// Browser and agent of every Teams account, started, stopped and wiped on request of the web app.
export class Accounts {
  private readonly accounts = new Map<number, Account>();
  private readonly queues = new Map<number, Promise<unknown>>();
  private readonly makeProcess: NonNullable<Deps["process"]>;
  private readonly focus: NonNullable<Deps["focus"]>;

  constructor(
    private readonly cfg: AccountsConfig,
    private readonly deps: Deps,
  ) {
    this.makeProcess = deps.process ?? ((name, command, output) => new Supervised(name, command, { log: (m) => this.say(m), output }));
    this.focus = deps.focus ?? ((n) => focusWindow(n, cfg));
  }

  start(n: number) {
    return this.queued(n, async () => {
      const a = this.account(n);
      if (!a.browser.active) this.prepareProfile(n);
      a.browser.start();
      a.agent.start();
      this.say(`account ${n} started`);
    });
  }

  // agent first: it would log the browser as gone
  stop(n: number) {
    return this.queued(n, async () => {
      const a = this.accounts.get(n);
      if (!a) return;
      await a.agent.stop();
      await a.browser.stop();
      this.say(`account ${n} stopped`);
    });
  }

  // Deletes the Microsoft session of the account: every entry of its profile directory. The directory itself
  // stays, it can be a mount point.
  wipe(n: number) {
    return this.queued(n, async () => {
      const a = this.accounts.get(n);
      if (a && (a.browser.active || a.agent.active)) throw new AccountError(409, `Account ${n} is running: stop it first`);
      const dir = profileDir(n, this.cfg);
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir)) {
        try {
          fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        } catch {
          // listed below
        }
      }
      const left = fs.readdirSync(dir);
      if (left.length) throw new AccountError(500, `account ${n}: not wiped, left: ${left.join(" ")}`);
      this.say(`account ${n} wiped`);
    });
  }

  async show(n: number): Promise<boolean> {
    this.check(n);
    const a = this.accounts.get(n);
    if (!a?.browser.running) return false;
    return this.focus(n);
  }

  status(): AccountStatus[] {
    const state = (p: ProcessLike): ProcessState => ({ running: p.running, pid: p.pid, restarts: p.restarts, lastExit: p.lastExit });
    return [...this.accounts.entries()].sort(([x], [y]) => x - y).map(([account, a]) => ({ account, browser: state(a.browser), agent: state(a.agent) }));
  }

  async stopAll() {
    await Promise.all([...this.accounts.keys()].map((n) => this.stop(n)));
  }

  // the agents' own lines go out as "[N] <line>", the supervisor's under its prefix
  private say(message: string) {
    this.deps.log(format("supervisor", message));
  }

  private check(n: number) {
    if (!Number.isInteger(n) || n < 1 || n > this.cfg.slotCount) throw new AccountError(404, `No account ${n}: accounts are 1 to ${this.cfg.slotCount}`);
  }

  private queued<T>(n: number, fn: () => Promise<T>): Promise<T> {
    try {
      this.check(n);
    } catch (e) {
      return Promise.reject(e);
    }
    const run = (this.queues.get(n) ?? Promise.resolve()).then(fn, fn);
    this.queues.set(
      n,
      run.catch(() => undefined),
    );
    return run;
  }

  private account(n: number): Account {
    let a = this.accounts.get(n);
    if (!a) {
      const browser = this.makeProcess(`browser-${n}`, () => browserCommand(n, this.cfg));
      const agent = this.makeProcess(`agent-${n}`, () => agentCommand(n, this.cfg), (line) => this.deps.log(`[${n}] ${line}`));
      a = { browser, agent };
      this.accounts.set(n, a);
    }
    return a;
  }

  private prepareProfile(n: number) {
    const dir = profileDir(n, this.cfg);
    fs.mkdirSync(dir, { recursive: true });
    // A directory made by Docker (a bind mount or a volume no browser ever used) belongs to root: the browser
    // writes its profile there. What is inside stays as it is.
    if (process.getuid?.() === 0) {
      const { uid, gid } = fs.statSync(dir);
      if (uid !== this.cfg.uid || gid !== this.cfg.gid) fs.chownSync(dir, this.cfg.uid, this.cfg.gid);
    }
    for (const lock of LOCKS) fs.rmSync(path.join(dir, ".config", "chromium", lock), { force: true });
  }
}

// wlrctl talks to the compositor of the desktop, which accepts only its own user
function focusWindow(n: number, cfg: AccountsConfig): Promise<boolean> {
  const env: Record<string, string> = { PATH, ...cfg.session };
  return new Promise((resolve) => {
    execFile(
      cfg.wlrctl,
      ["toplevel", "focus", `app_id:teamsrelay-${n}`],
      { uid: cfg.uid, gid: cfg.gid, env: env as NodeJS.ProcessEnv, timeout: 5000 },
      (err: Error | null) => resolve(!err),
    );
  });
}
