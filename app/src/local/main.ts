// TeamsRelay local: one Teams account in a local browser, relayed to the phone. Built into dist/relay.cjs (esbuild).
//   node dist/relay.cjs          runs the relay: browser, agent, push, API (environment: src/local/config.ts, relay.env)
//   node dist/relay.cjs login    opens the browser on its profile for the sign-in, closes it once Teams shows the chats
//   node dist/relay.cjs --check  loads the runtime dependencies, the page scripts and the app files, then exits
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { chromium, type BrowserContext } from "playwright-core";
import { ConfigError } from "@/shared/env";
import { isTeamsUrl, pickTeamsPage } from "@/agent/logic/hosts";
import { NewMessageDetector } from "@/agent/logic/new-messages";
import { errorText, log } from "@/agent/log";
import { runAgent } from "@/agent/loop";
import { Media } from "@/agent/media";
import { Notifier } from "@/agent/push/notifier";
import { loadVapidKeys } from "@/agent/push/vapid";
import { SlotStore } from "@/agent/store/slot-store";
import { sleep } from "@/agent/teams/page";
import * as activityScripts from "@/agent/teams/scripts/activity";
import * as callScripts from "@/agent/teams/scripts/calls";
import * as chatListScripts from "@/agent/teams/scripts/chat-list";
import * as composeScripts from "@/agent/teams/scripts/compose";
import * as conversationScripts from "@/agent/teams/scripts/conversation";
import * as mediaScripts from "@/agent/teams/scripts/media";
import * as memberScripts from "@/agent/teams/scripts/members";
import * as mentionScripts from "@/agent/teams/scripts/mentions";
import * as actionScripts from "@/agent/teams/scripts/message-actions";
import * as pageScripts from "@/agent/teams/scripts/page-state";
import * as signInScripts from "@/agent/teams/scripts/sign-in";
import { probePage, readIdentity } from "@/agent/teams/scripts/page-state";
import { SEL, TEXTS } from "@/agent/teams/selectors";
import { STATE } from "@/shared/slot-db/state";
import { BrowserKeeper, launchBrowser, openTeams } from "./browser";
import { BrowserHost, loadPlaywrightMcp } from "./browser-host";
import { BrowserLink } from "./browser-link";
import { CallBridge } from "./call-bridge";
import * as bridgeScripts from "./call-bridge-page";
import { loadConfig, readToken, type Config } from "./config";
import { RelayDevices } from "./devices";
import { acquireLock, LOGIN_TIMEOUT_MS, LockError } from "./lock";
import { appFiles, startServer } from "./server";
import { ServerLink, ServerNotifier } from "./server-link";
import { onStop } from "./stop";

// the bundle is dist/relay.cjs in app/: the page of the app is in src/local/web, the files it shares with the web app
// (service worker, manifest, icons) in public/
const APP_DIR = path.resolve(__dirname, "..");
const WEB_DIR = path.join(APP_DIR, "src", "local", "web");
const PUBLIC_DIR = path.join(APP_DIR, "public");

// The build runs this: a runtime package missing, a native binary of another platform, a page script the bundler
// changed (they reach the page as source text) or a file of the app missing fail the build
function check() {
  const db = new Database(":memory:");
  const sqlite = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  db.close();
  let scripts = 0;
  for (const scriptModule of [activityScripts, chatListScripts, composeScripts, conversationScripts, mediaScripts, memberScripts, mentionScripts, actionScripts, pageScripts, callScripts, signInScripts, bridgeScripts]) {
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
  const files = appFiles(WEB_DIR, PUBLIC_DIR);
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) throw new Error(`app files missing: ${missing.join(", ")}`);
  // the browser for MCP clients: @playwright/mcp and the Playwright it brings, loaded only when RELAY_BROWSER=1
  const mcp = loadPlaywrightMcp();
  log.info("relay", "check ok", {
    sqlite,
    playwright: typeof chromium.launchPersistentContext === "function",
    browserMcp: typeof mcp.createConnection === "function" && typeof mcp.launch === "function",
    scripts,
    web: files.length,
  });
}

// The profile for the relay. While the sign-in holds it the relay waits (pm2 would otherwise restart it until it gave
// up, and the relay would stay down after the sign-in); another relay on it stops this one.
async function relayLock(file: string): Promise<() => void> {
  let waiting = false;
  for (;;) {
    try {
      return acquireLock(file, "relay");
    } catch (e) {
      if (!(e instanceof LockError) || e.heldBy !== "login") throw e;
      if (!waiting) log.info("relay", "waiting for the sign-in to finish");
      waiting = true;
      await sleep(5000);
    }
  }
}

async function run(config: Config) {
  // stop handling from the first moment: pm2 may stop the relay while it waits for the sign-in or starts, and must not
  // have to kill it. What to close grows as the relay opens it.
  let close = async () => undefined;
  onStop(() => close());
  const release = await relayLock(config.lockFile);
  process.on("exit", release);
  const token = readToken(config.tokenFile);
  const store = SlotStore.open(config.dbPath);
  const devices = RelayDevices.open(config.dbPath);
  const vapid = loadVapidKeys(config.vapid.privateKeyFile, config.vapid.appKeyFile);
  if (!vapid) log.warn("push", "no VAPID private key: push notifications off, run npm run relay:setup", { file: config.vapid.privateKeyFile });
  // joined to a server, the sound of a call answered or placed from its app goes to that app (call-bridge.ts)
  const bridge = config.server ? new CallBridge(config.server) : null;
  if (bridge) store.setState(STATE.callAudio, "1");
  // joined to a server, the account shows in its web app, which sends the notifications to the devices of its owner
  const link = config.server
    ? new ServerLink({
        ...config.server,
        host: config.hostLabel,
        dbPath: config.dbPath,
        store,
        mediaDir: config.mediaDir,
        filesDir: config.filesDir,
        uploadsDir: config.uploadsDir,
        onCallAudio: () => bridge?.arm(),
      })
    : null;
  const notifier = link ? new ServerNotifier(link, store) : new Notifier({ store, devices, vapid, subject: config.vapid.subject, ntfy: config.ntfy });
  // the hook of the bridge goes in before Teams loads, and before the microphone hook of the agent
  const launch = async () => {
    const context = await launchBrowser({ profileDir: config.profileDir, channel: config.channel, extraArgs: config.browserArgs });
    await bridge?.attach(context).catch((e: unknown) => log.warn("bridge", `call sound hook: ${errorText(e)}`));
    return context;
  };
  const keeper = new BrowserKeeper(launch, config.teamsUrl);
  const server = await startServer({ ...config.api, store, devices, token, vapidKey: vapid?.publicKey ?? "", webDir: WEB_DIR, publicDir: PUBLIC_DIR, mediaDir: config.mediaDir });
  log.info("relay", "start", { browser: config.channel, api: server.url, push: !!vapid, ntfy: !!config.ntfy, devices: devices.count(), server: config.server?.url, mcpBrowser: !!config.browser });
  const stopped = new AbortController();
  // files/: the attachments a server joined asks for (the app of the relay sends no download command)
  const media = new Media(config.mediaDir, config.filesDir);
  const loop = runAgent({ config, store, notifier, media, detector: new NewMessageDetector() }, keeper, stopped.signal);
  const linked = link?.run(stopped.signal);
  // RELAY_BROWSER=1: a browser of its own for the MCP clients of the server, driven over a socket the relay opens
  const browserLink =
    config.browser && config.server
      ? new BrowserLink({ ...config.server, host: new BrowserHost({ ...config.browser, channel: config.channel }) })
      : null;
  browserLink?.start();
  close = async () => {
    stopped.abort();
    bridge?.stop();
    await browserLink?.stop();
    await keeper.close();
    await loop;
    await linked;
    await server.close();
    devices.close();
    store.close();
  };
  await loop;
}

// The one-time sign-in: the browser of the relay on its profile, for a person to sign in to Teams (MFA included).
// Done once Teams shows the chat list and the account; the browser then closes and keeps the session on disk.
async function login(config: Config): Promise<number> {
  const release = acquireLock(config.lockFile, "login");
  process.on("exit", release);
  let context: BrowserContext | null = await launchBrowser({ profileDir: config.profileDir, channel: config.channel });
  context.on("close", () => (context = null));
  if (!pickTeamsPage(context.pages())) await openTeams(context, config.teamsUrl);
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
  console.error("Nobody signed in within 15 minutes: run npm run relay:login again.");
  return 1;
}

async function main() {
  if (process.argv.includes("--check")) return check();
  // relay.env next to package.json (pm2 and npm run start the relay from there); the process environment wins. Not
  // .env: Next.js would load that one into the web app.
  if (fs.existsSync("relay.env")) process.loadEnvFile("relay.env");
  const config = loadConfig();
  if (process.argv[2] === "login") process.exit(await login(config));
  await run(config);
}

main().catch((e: unknown) => {
  const known = e instanceof ConfigError || e instanceof LockError;
  log.warn("relay", known ? e.message : errorText(e));
  process.exit(1);
});
