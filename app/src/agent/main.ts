// TeamsRelay agent of one slot: drives Teams web in its Chromium over the Chrome DevTools Protocol, keeps
// data/N/messages.db for the web app, sends the push notifications. Built into dist/agent.cjs (esbuild).
//   node agent.cjs           runs the agent (environment: src/agent/config.ts)
//   node agent.cjs --check   loads the runtime dependencies and the page scripts, then exits
import Database from "better-sqlite3";
import { chromium } from "playwright-core";
import { CdpBrowser } from "./cdp";
import { ConfigError, loadConfig } from "./config";
import { NewMessageDetector } from "./logic/new-messages";
import { errorText, log } from "./log";
import { runAgent } from "./loop";
import { Media } from "./media";
import { Notifier } from "./push/notifier";
import { loadVapidKeys } from "./push/vapid";
import { AppStore } from "./store/app-store";
import { SlotStore } from "./store/slot-store";
import * as activityScripts from "./teams/scripts/activity";
import * as chatListScripts from "./teams/scripts/chat-list";
import * as composeScripts from "./teams/scripts/compose";
import * as conversationScripts from "./teams/scripts/conversation";
import * as mediaScripts from "./teams/scripts/media";
import * as memberScripts from "./teams/scripts/members";
import * as mentionScripts from "./teams/scripts/mentions";
import * as actionScripts from "./teams/scripts/message-actions";
import * as pageScripts from "./teams/scripts/page-state";

// The image runs this at build time: a runtime package missing from the image, a native binary of another
// architecture, or a page script the bundler changed (they reach the page as source text) fail the build.
function check() {
  const db = new Database(":memory:");
  const sqlite = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  db.close();
  let scripts = 0;
  for (const scriptModule of [activityScripts, chatListScripts, composeScripts, conversationScripts, mediaScripts, memberScripts, mentionScripts, actionScripts, pageScripts]) {
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
  log.info("agent", "check ok", { sqlite, playwright: typeof chromium.connectOverCDP === "function", scripts });
}

async function main() {
  if (process.argv.includes("--check")) return check();
  // PID 1 in the container: without a handler SIGTERM is ignored and "docker stop" waits for its timeout
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
  const config = loadConfig();
  const store = SlotStore.open(config.dbPath);
  const vapid = loadVapidKeys(config.vapid.privateKeyFile, config.vapid.appKeyFile);
  if (!vapid) log.warn("push", "no VAPID private key: push notifications off", { file: config.vapid.privateKeyFile });
  // pushes go to the devices of the slot owner, in the web app's database
  const devices = new AppStore(config.appDb, config.slot);
  const notifier = new Notifier({ store, devices, vapid, subject: config.vapid.subject, ntfy: config.ntfy });
  log.info("agent", "start", { slot: config.slot, cdp: config.cdp, push: !!vapid, ntfy: !!config.ntfy });
  const media = new Media(config.mediaDir, config.filesDir);
  await runAgent({ config, store, notifier, media, detector: new NewMessageDetector() }, new CdpBrowser(config.cdp));
}

main().catch((e: unknown) => {
  log.warn("agent", e instanceof ConfigError ? `configuration: ${e.message}` : errorText(e));
  process.exit(1);
});
