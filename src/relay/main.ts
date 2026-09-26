// TeamsRelay local: one Teams account in a local browser, relayed to the phone. Built into dist/relay.cjs (esbuild).
//   node dist/relay.cjs          runs the relay: browser, agent, push, API (environment: src/relay/config.ts, .env)
//   node dist/relay.cjs login    opens the browser on its profile for the sign-in, closes it once Teams shows the chats
//   node dist/relay.cjs --check  loads the runtime dependencies, the page scripts and the app files, then exits
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { chromium, type BrowserContext } from "playwright-core";
import { NewMessageDetector } from "@/agent/logic/new-messages";
import { isTeamsUrl, isLoginUrl, pickTeamsPage } from "@/agent/logic/hosts";
import { errorText, log } from "@/agent/log";
import { runAgent } from "@/agent/loop";
import { Media } from "@/agent/media";
import { Notifier } from "@/agent/push/notifier";
import { loadVapidKeys } from "@/agent/push/vapid";
import { SlotStore } from "@/agent/store/slot-store";
import { sleep } from "@/agent/teams/page";
import * as chatListScripts from "@/agent/teams/scripts/chat-list";
import * as composeScripts from "@/agent/teams/scripts/compose";
import * as conversationScripts from "@/agent/teams/scripts/conversation";
import * as mediaScripts from "@/agent/teams/scripts/media";
import * as actionScripts from "@/agent/teams/scripts/message-actions";
import * as pageScripts from "@/agent/teams/scripts/page-state";
import { probePage, readIdentity } from "@/agent/teams/scripts/page-state";
import { SEL, TEXTS } from "@/agent/teams/selectors";
import { BrowserKeeper, launchBrowser, openTeams } from "./browser";
import { ConfigError, loadConfig, readToken, type Config } from "./config";
import { acquireLock, LockError } from "./lock";
import { startServer } from "./server";

// the bundle is dist/relay.cjs: the app is in web/ next to dist/
const WEB_DIR = path.resolve(__dirname, "..", "web");
const WEB_FILES = ["index.html", "app.js", "app.css", "sw.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];
// the sign-in waits this long for someone at the window
const LOGIN_TIMEOUT_MS = 15 * 60_000;

// The build runs this: a runtime package missing, a native binary of another platform, a page script the bundler
// changed (they reach the page as source text) or a file of the app missing fail the build
function check() {
  const db = new Database(":memory:");
  const sqlite = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  db.close();
  let scripts = 0;
  for (const scriptModule of [chatListScripts, composeScripts, conversationScripts, mediaScripts, actionScripts, pageScripts]) {
    for (const [name, fn] of Object.entries(scriptModule)) {
      if (typeof fn !== "function") continue;
      const source = fn.toString();
      if (/\b__(name|async|awaiter|spreadValues|spreadProps|objRest|publicField|require|toESM)\b/.test(source)) {
        throw new Error(`page script ${name} calls a bundler helper, which does not exist in the page`);
      }
      new Function(`return (${source})`);
      scripts++;
    }
  }
  const missing = WEB_FILES.filter((f) => !fs.existsSync(path.join(WEB_DIR, f)));
  if (missing.length) throw new Error(`app files missing in ${WEB_DIR}: ${missing.join(", ")}`);
  log.info("relay", "check ok", { sqlite, playwright: typeof chromium.launchPersistentContext === "function", scripts, web: WEB_FILES.length });
}

// Stops on SIGINT, SIGTERM and the shutdown message of pm2 (Windows has no signals to send): the browser is closed
// so that it writes its profile out
function onStop(stop: () => Promise<void>) {
  let stopping = false;
  const handler = () => {
    if (stopping) return;
    stopping = true;
    log.info("relay", "stopping");
    const force = setTimeout(() => process.exit(0), 10_000);
    force.unref();
    stop().finally(() => process.exit(0));
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, handler);
  process.on("message", (m) => m === "shutdown" && handler());
}

async function run(config: Config) {
  const release = acquireLock(config.lockFile, "relay");
  process.on("exit", release);
  const token = readToken(config.tokenFile);
  const store = SlotStore.open(config.dbPath);
  const vapid = loadVapidKeys(config.vapid.privateKeyFile, config.vapid.appKeyFile);
  if (!vapid) log.warn("push", "no VAPID private key: push notifications off, run npm run setup", { file: config.vapid.privateKeyFile });
  const notifier = new Notifier({ store, vapid, subject: config.vapid.subject, ntfy: config.ntfy });
  const keeper = new BrowserKeeper(() => launchBrowser({ profileDir: config.profileDir, channel: config.channel }), config.teamsUrl);
  const server = await startServer({ ...config.api, store, token, vapidKey: vapid?.publicKey ?? "", webDir: WEB_DIR, mediaDir: config.mediaDir });
  log.info("relay", "start", { browser: config.channel, api: server.url, push: !!vapid, ntfy: !!config.ntfy, devices: store.pushSubscriptionCount() });
  const stopped = new AbortController();
  onStop(async () => {
    stopped.abort();
    await server.close();
    await keeper.close();
    store.close();
  });
  await runAgent({ config, store, notifier, media: new Media(config.mediaDir), detector: new NewMessageDetector() }, keeper, stopped.signal);
}

// The one-time sign-in: the browser of the relay on its profile, for a person to sign in to Teams (MFA included).
// Done once Teams shows the chat list and the account; the browser then closes and keeps the session on disk.
async function login(config: Config): Promise<number> {
  const release = acquireLock(config.lockFile, "login");
  process.on("exit", release);
  let context: BrowserContext | null = await launchBrowser({ profileDir: config.profileDir, channel: config.channel });
  context.on("close", () => (context = null));
  if (!context.pages().some((p) => isTeamsUrl(p.url()) || isLoginUrl(p.url()))) await openTeams(context, config.teamsUrl);
  console.log("Sign in to Teams in the browser window that just opened, MFA included.");
  console.log('Answer "Yes" to "Stay signed in?": the session then survives restarts of the relay.');
  console.log("The window closes by itself once Teams shows your chats.");
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (context && Date.now() < deadline) {
    const page = pickTeamsPage(context.pages());
    if (page && isTeamsUrl(page.url())) {
      const probe = await page.evaluate(probePage, { s: SEL, t: TEXTS, withPresence: false }).catch(() => null);
      const me = probe?.domReady && !probe.reduced ? await page.evaluate(readIdentity, SEL).catch(() => null) : null;
      if (me && (me.email || me.name)) {
        console.log(`Signed in: ${me.name}${me.email ? ` <${me.email}>` : ""}${me.tenant ? `, ${me.tenant}` : ""}`);
        // Teams writes its tokens right after it loads: let it finish before the browser closes
        await sleep(5000);
        await context?.close();
        return 0;
      }
    }
    await sleep(2000);
  }
  if (!context) {
    console.error("The window was closed before Teams showed the chats: sign-in not confirmed.");
    return 1;
  }
  await (context as BrowserContext).close();
  console.error("Nobody signed in within 15 minutes: run npm run login again.");
  return 1;
}

async function main() {
  if (process.argv.includes("--check")) return check();
  // .env next to package.json (pm2 and npm run start the relay from there); the process environment wins
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();
  if (process.argv[2] === "login") process.exit(await login(config));
  await run(config);
}

main().catch((e: unknown) => {
  const known = e instanceof ConfigError || e instanceof LockError;
  log.warn("relay", known ? e.message : errorText(e));
  process.exit(1);
});
