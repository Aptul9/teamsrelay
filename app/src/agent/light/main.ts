// TeamsRelay light agent of one slot: a Teams account with no browser of its own. It reads the chats and the Activity
// feed through the Teams services, sends the push notifications and runs the commands of the web app, on the sign-in
// the account's browser run captured (src/agent/jobs/light-token.ts). Built into dist/light.cjs (esbuild).
//   node light.cjs           runs the light agent (environment: src/agent/config.ts)
//   node light.cjs --check   loads the runtime dependencies, then exits
import Database from "better-sqlite3";
import { ConfigError } from "@/shared/env";
import { loadConfig } from "../config";
import { errorText, log } from "../log";
import { NewMessageDetector } from "../logic/new-messages";
import { FcmSender, loadServiceAccount } from "../push/fcm";
import { Notifier } from "../push/notifier";
import { loadVapidKeys } from "../push/vapid";
import { AppStore } from "../store/app-store";
import { SlotStore } from "../store/slot-store";
import { LightApi } from "./api";
import type { Light } from "./context";
import { runLight } from "./loop";
import { LightToken } from "./token";

function check() {
  const db = new Database(":memory:");
  const sqlite = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  db.close();
  log.info("light", "check ok", { sqlite });
}

async function main() {
  if (process.argv.includes("--check")) return check();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
  const config = loadConfig();
  const store = SlotStore.open(config.dbPath);
  const vapid = loadVapidKeys(config.vapid.privateKeyFile, config.vapid.appKeyFile);
  if (!vapid) log.warn("push", "no VAPID private key: push notifications off", { file: config.vapid.privateKeyFile });
  const devices = new AppStore(config.appDb, config.slot);
  const sa = loadServiceAccount(config.fcmCredentials);
  const notifier = new Notifier({ store, devices, vapid, subject: config.vapid.subject, ntfy: config.ntfy, fcm: sa ? new FcmSender(sa) : null, answerable: false });
  const token = new LightToken(config.lightTokenFile);
  const api = new LightApi(token, () => token.stored()?.region || "emea");
  const l: Light = {
    config,
    store,
    notifier,
    detector: new NewMessageDetector(),
    api,
    token,
    me: { oid: "", name: "" },
    list: { ids: new Map(), names: new Map(), members: new Map() },
    people: new Map(),
    mentioned: new Set(),
    due: { list: 0, activity: 0 },
    scanAt: 0,
    error: "",
    signedOut: false,
    health: null,
  };
  log.info("light", "start", { slot: config.slot, poll: config.lightPoll, push: !!vapid, fcm: !!sa, signIn: !!token.stored() });
  await runLight(l);
}

main().catch((e: unknown) => {
  log.warn("light", e instanceof ConfigError ? `configuration: ${e.message}` : errorText(e));
  process.exit(1);
});
