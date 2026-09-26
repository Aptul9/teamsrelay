// The agent bundle as a process, against a local Chrome that serves the captured chat list on the Teams host:
// connection, health row, chat list, new message detection, commands, reconnection after the browser
// restarts, exit without a Teams tab, SIGTERM. About two minutes: the exit waits the real 60 s.
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { build } from "esbuild";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../helpers";
import { fixture } from "./chrome";

const APP = path.resolve(__dirname, "../..");
let dir = "";
let bundle = "";
let port = 0;
let context: BrowserContext | null = null;
let agent: ChildProcess | null = null;
let lines: string[] = [];

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: p } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return p;
}

async function openTeams(page: Page) {
  await page.route("https://teams.microsoft.com/**", (r) => r.fulfill({ contentType: "text/html", body: `<html><body>${fixture("chat-list.html")}</body></html>` }));
  await page.goto("https://teams.microsoft.com/v2/");
}

async function startChrome() {
  context = await chromium.launchPersistentContext(path.join(dir, "profile"), { channel: "chrome", headless: true, args: [`--remote-debugging-port=${port}`] });
  await openTeams(context.pages()[0] ?? (await context.newPage()));
}

function startAgent() {
  lines = [];
  agent = spawn(process.execPath, [bundle], {
    env: {
      ...process.env,
      NODE_PATH: path.join(APP, "node_modules"),
      CDP: `http://127.0.0.1:${port}`,
      ACCOUNT: "2",
      DB_PATH: path.join(dir, "2", "messages.db"),
      APP_DB: path.join(dir, "app.db"),
      VAPID_PRIVATE: path.join(dir, "missing.pem"),
      VAPID_APPKEY: path.join(dir, "missing.txt"),
    },
  });
  for (const stream of [agent.stdout, agent.stderr]) stream?.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
  agent.on("error", (e) => lines.push(`[spawn error] ${e.message}`));
  agent.on("exit", (code, signal) => lines.push(`[exit] code=${code} signal=${signal}`));
}

async function until<T>(check: () => T | null | undefined | false, timeout: number, what: string): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; agent log:\n${lines.slice(-15).join("\n")}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// undefined until the agent has created the database
function query<T>(sql: string, ...args: unknown[]): T | undefined {
  let db: Database.Database | undefined;
  try {
    db = new Database(path.join(dir, "2", "messages.db"), { readonly: true, fileMustExist: true });
    return db.prepare(sql).get(...args) as T | undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
const health = () => JSON.parse(query<{ v: string }>("SELECT v FROM state WHERE k='health'")?.v ?? "{}");
const logged = (pattern: RegExp) => lines.filter((l) => pattern.test(l)).length;
const exited = (p: ChildProcess) => new Promise<{ code: number | null; signal: string | null }>((resolve) => p.once("exit", (code, signal) => resolve({ code, signal })));

beforeAll(async () => {
  dir = tempDir("teamsrelay-agent-process-");
  bundle = path.join(dir, "agent.cjs");
  await build({
    absWorkingDir: APP,
    entryPoints: ["src/agent/main.ts"],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    external: ["playwright-core", "better-sqlite3"],
    outfile: bundle,
    logLevel: "warning",
  });
  port = await freePort();
  await startChrome();
  startAgent();
});

afterAll(async () => {
  agent?.kill("SIGKILL");
  await context?.close().catch(() => undefined);
});

describe("agent process", () => {
  it("connects, finds the Teams tab, saves the chat list and writes a green health row", async () => {
    await until(() => health().overall === "green", 30_000, "a green health row");
    expect(health()).toMatchObject({ cdp: "ok", teams: "ok", hook: "ok", watcher: "ok" });
    expect(query<{ n: number }>("SELECT COUNT(*) AS n FROM chats")?.n).toBe(40);
    expect(logged(/^agent: start slot=2/)).toBe(1);
    expect(logged(/^cdp: connected/)).toBe(1);
  }, 60_000);

  it("notices a new incoming message in the list", async () => {
    const page = context?.pages()[0] as Page;
    const name = await page.evaluate(() => {
      // first chat of the Chats section that is not muted (muted chats never notify)
      const row = [...document.querySelectorAll<HTMLElement>('[role="treeitem"][aria-level="2"][id^="menu"]')].find((r) => {
        const head = (r.parentElement?.closest('[role="treeitem"][aria-level="1"]')?.querySelector(":scope > :not([role=\"group\"])") as HTMLElement | null)?.innerText ?? "";
        return /^Chats/.test(head.trim()) && r.getAttribute("data-item-type") !== "muted-chat" && !r.querySelector('[data-testid="muted-icon"]');
      }) as HTMLElement;
      const leaves = [...row.querySelectorAll("*")].filter((e) => e.children.length === 0 && (e.textContent || "").trim());
      const time = leaves.find((e) => /^\d{1,2}\/\d{1,2}$/.test((e.textContent || "").trim()));
      if (time) time.textContent = "10:42";
      (leaves[leaves.length - 1] as HTMLElement).textContent = "are you there for the incoming check?";
      return (row.innerText || "").split(/\s+(?:\d{1,2}:\d{2}|\d{1,2}\/\d{1,2})/)[0].replace(/^(Available|Away|Busy|Offline)\s+/, "").trim();
    });
    const row = await until(() => query<{ title: string; body: string }>("SELECT title, body FROM messages ORDER BY id DESC LIMIT 1"), 20_000, "a notified message");
    expect(row.body).toBe("are you there for the incoming check?");
    expect(name.startsWith(row.title)).toBe(true);
    expect(logged(/^NEWMSG: /)).toBe(1);
  }, 60_000);

  it("runs queued commands and marks unknown ones done", async () => {
    const db = new Database(path.join(dir, "2", "messages.db"));
    const insert = db.prepare("INSERT INTO commands(ts, type, arg1, arg2) VALUES(0, ?, '', '')");
    const ids = [Number(insert.run("resync").lastInsertRowid), Number(insert.run("teleport").lastInsertRowid)];
    db.close();
    for (const id of ids) await until(() => query<{ status: string }>("SELECT status FROM commands WHERE id=?", id)?.status === "done", 15_000, `command ${id}`);
    expect(logged(/^CMD: resync/)).toBe(1);
  }, 60_000);

  it("reconnects when the browser restarts", async () => {
    await context?.close();
    await until(() => logged(/^cdp: connection lost/) === 1, 15_000, "the lost connection");
    await startChrome();
    await until(() => logged(/^cdp: connected/) === 2, 30_000, "the second connection");
    const since = Math.floor(Date.now() / 1000);
    await until(() => health().teams === "ok" && health().ts >= since, 30_000, "a fresh health row");
  }, 60_000);

  it("exits 60 s after the Teams tab went away, so Docker starts it again", async () => {
    const done = exited(agent as ChildProcess);
    await (context?.pages()[0] as Page).goto("about:blank");
    await until(() => health().teams === "loading", 15_000, "the loading health row");
    const t0 = Date.now();
    expect((await done).code).toBe(1);
    expect(Date.now() - t0).toBeGreaterThan(50_000);
    expect(logged(/^agent: no Teams tab for 60 s/)).toBe(1);
  }, 120_000);

  it("exits at once on SIGTERM", async () => {
    await openTeams(context?.pages()[0] as Page);
    startAgent();
    await until(() => logged(/^cdp: connected/) === 1, 30_000, "the connection");
    const done = exited(agent as ChildProcess);
    const t0 = Date.now();
    agent?.kill("SIGTERM");
    const { code } = await done;
    expect(Date.now() - t0).toBeLessThan(3000);
    // on Windows kill() terminates the process without a signal handler to run
    if (process.platform !== "win32") expect(code).toBe(0);
  }, 60_000);
});
