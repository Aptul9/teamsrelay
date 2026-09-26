import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// Environment of the relay, from .env next to package.json or from the process (pm2). Checked once at start: a wrong
// value stops the relay with the reason, instead of a failure later on the Teams page.
const Env = z.object({
  // browser profile, database, images, push keys, API token: everything the relay keeps
  STATE_DIR: z.string().default("state"),
  // installed browser Playwright drives: Google Chrome or Microsoft Edge
  BROWSER_CHANNEL: z.enum(["chrome", "msedge"]).default("chrome"),
  TEAMS_URL: z.url({ protocol: /^https$/ }).default("https://teams.cloud.microsoft/"),
  // address of the API: loopback unless the phone reaches it some other way (docs/design.md, Reaching the relay)
  RELAY_BIND: z.union([z.ipv4(), z.ipv6()]).default("127.0.0.1"),
  RELAY_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  // HTTPS on the API itself, for a phone that reaches it without a proxy that terminates TLS
  RELAY_TLS_CERT: z.string().optional(),
  RELAY_TLS_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().regex(/^(mailto:|https:\/\/)/, "must be a mailto: or https:// URL").default("mailto:admin@example.com"),
  NTFY_URL: z.url({ protocol: /^https?$/ }).default("https://ntfy.sh"),
  NTFY_TOPIC: z.string().default(""),
  // name of this machine in the alerts ("sign in again in the relay window on <HOST_LABEL>")
  HOST_LABEL: z.string().default(os.hostname()),
});

export type Config = {
  stateDir: string;
  profileDir: string;
  dbPath: string;
  mediaDir: string;
  tokenFile: string;
  lockFile: string;
  channel: "chrome" | "msedge";
  teamsUrl: string;
  api: { bind: string; port: number; tls: { cert: string; key: string } | null };
  vapid: { privateKeyFile: string; appKeyFile: string; subject: string };
  ntfy: { url: string; topic: string } | null;
  hostLabel: string;
  // seconds a problem lasts before its push: Teams signed out, browser not starting
  alerts: { signInAfter: number; browserAfter: number };
};

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Config {
  // an empty variable (FOO= in .env) counts as unset
  const given = Object.fromEntries(Object.keys(Env.shape).map((k) => [k, env[k] === "" ? undefined : env[k]]));
  const r = Env.safeParse(given);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const e = r.data;
  if (!!e.RELAY_TLS_CERT !== !!e.RELAY_TLS_KEY) throw new ConfigError("RELAY_TLS_CERT and RELAY_TLS_KEY go together");
  const stateDir = path.resolve(cwd, e.STATE_DIR);
  const vapidDir = path.join(stateDir, "vapid");
  return {
    stateDir,
    profileDir: path.join(stateDir, "profile"),
    dbPath: path.join(stateDir, "relay.db"),
    mediaDir: path.join(stateDir, "media"),
    tokenFile: path.join(stateDir, "token"),
    lockFile: path.join(stateDir, "relay.lock"),
    channel: e.BROWSER_CHANNEL,
    teamsUrl: e.TEAMS_URL,
    api: {
      bind: e.RELAY_BIND,
      port: e.RELAY_PORT,
      tls: e.RELAY_TLS_CERT && e.RELAY_TLS_KEY ? { cert: path.resolve(cwd, e.RELAY_TLS_CERT), key: path.resolve(cwd, e.RELAY_TLS_KEY) } : null,
    },
    vapid: { privateKeyFile: path.join(vapidDir, "private_key.pem"), appKeyFile: path.join(vapidDir, "appkey.txt"), subject: e.VAPID_SUBJECT },
    ntfy: e.NTFY_TOPIC ? { url: e.NTFY_URL, topic: e.NTFY_TOPIC } : null,
    hostLabel: e.HOST_LABEL,
    alerts: { signInAfter: 60, browserAfter: 300 },
  };
}

// The token the app sends with every call, written by scripts/setup.mjs
export function readToken(file: string): string {
  let token = "";
  try {
    token = fs.readFileSync(file, "utf8").trim();
  } catch {
    // reported below
  }
  if (token.length < 24) throw new ConfigError(`no API token in ${file}: run npm run setup`);
  return token;
}
