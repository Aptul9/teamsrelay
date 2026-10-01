import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ConfigError } from "@/agent/config";
import type { AgentSettings } from "@/agent/context";

// Environment of the local relay, from relay.env next to package.json or from the process (pm2). Checked once at
// start: a wrong value stops the relay with the reason, instead of a failure later on the Teams page.
const Env = z.object({
  // browser profile, database, images, push keys, API token: everything the relay keeps
  STATE_DIR: z.string().default("state"),
  // installed browser Playwright drives: Google Chrome or Microsoft Edge
  BROWSER_CHANNEL: z.enum(["chrome", "msedge"]).default("chrome"),
  TEAMS_URL: z.url({ protocol: /^https$/ }).default("https://teams.cloud.microsoft/"),
  // address of the API: loopback unless the phone reaches it some other way (docs/setup.md, Local relay)
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
  // a TeamsRelay server this relay joins, as an account on another computer: the address of its web app and the token
  // the app showed when the account was added (docs/design/2026-09-27-relay-joins-server.md)
  SERVER_URL: z.url({ protocol: /^https?$/ }).optional(),
  SERVER_TOKEN: z.string().min(32, "must be the token the web app showed").optional(),
  // tests only: more command-line switches of the browser, separated by spaces (a fake microphone, for one)
  BROWSER_ARGS: z.string().default(""),
});

// The token goes in every request: plain HTTP only to a server on this machine
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type Config = AgentSettings & {
  stateDir: string;
  profileDir: string;
  dbPath: string;
  mediaDir: string;
  filesDir: string;
  tokenFile: string;
  lockFile: string;
  channel: "chrome" | "msedge";
  teamsUrl: string;
  api: { bind: string; port: number; tls: { cert: string; key: string } | null };
  vapid: { privateKeyFile: string; appKeyFile: string; subject: string };
  ntfy: { url: string; topic: string } | null;
  hostLabel: string;
  // the server joined, null for a relay on its own
  server: { url: string; token: string } | null;
  browserArgs: string[];
};

export function loadConfig(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Config {
  // an empty variable (FOO= in relay.env) counts as unset
  const given = Object.fromEntries(Object.keys(Env.shape).map((k) => [k, env[k] === "" ? undefined : env[k]]));
  const r = Env.safeParse(given);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const e = r.data;
  if (!!e.RELAY_TLS_CERT !== !!e.RELAY_TLS_KEY) throw new ConfigError("RELAY_TLS_CERT and RELAY_TLS_KEY go together");
  if (!!e.SERVER_URL !== !!e.SERVER_TOKEN) throw new ConfigError("SERVER_URL and SERVER_TOKEN go together");
  if (e.SERVER_URL && new URL(e.SERVER_URL).protocol === "http:" && !LOOPBACK.has(new URL(e.SERVER_URL).hostname)) {
    throw new ConfigError("SERVER_URL: https:// needed, the token must not travel in clear (http:// only for localhost)");
  }
  const server = e.SERVER_URL && e.SERVER_TOKEN ? { url: e.SERVER_URL.replace(/\/+$/, ""), token: e.SERVER_TOKEN } : null;
  const stateDir = path.resolve(cwd, e.STATE_DIR);
  const vapidDir = path.join(stateDir, "vapid");
  return {
    stateDir,
    profileDir: path.join(stateDir, "profile"),
    dbPath: path.join(stateDir, "relay.db"),
    mediaDir: path.join(stateDir, "media"),
    filesDir: path.join(stateDir, "files"),
    tokenFile: path.join(stateDir, "token"),
    lockFile: path.join(stateDir, "relay.lock"),
    channel: e.BROWSER_CHANNEL,
    browserArgs: e.BROWSER_ARGS.split(/\s+/).filter(Boolean),
    teamsUrl: e.TEAMS_URL,
    api: {
      bind: e.RELAY_BIND,
      port: e.RELAY_PORT,
      tls: e.RELAY_TLS_CERT && e.RELAY_TLS_KEY ? { cert: path.resolve(cwd, e.RELAY_TLS_CERT), key: path.resolve(cwd, e.RELAY_TLS_KEY) } : null,
    },
    vapid: { privateKeyFile: path.join(vapidDir, "private_key.pem"), appKeyFile: path.join(vapidDir, "appkey.txt"), subject: e.VAPID_SUBJECT },
    ntfy: e.NTFY_TOPIC ? { url: e.NTFY_URL, topic: e.NTFY_TOPIC } : null,
    hostLabel: e.HOST_LABEL,
    server,
    // the app of the relay sends text only, and shows neither the Activity feed nor "Read by"; the web app of a server
    // joined does all three
    uploadsDir: path.join(stateDir, "uploads"),
    activity: !!server,
    readBy: !!server,
    // a call is answered on the computer of the relay, where its sound is: by hand in its window, and from the app of the
    // server joined, whose commands (answer, hang up, mute) the call watch then runs in that window
    answerCalls: !!server,
    alerts: {
      signInAfter: 60,
      browserAfter: 300,
      signIn: `Sign in again in the relay window on ${e.HOST_LABEL}`,
      browserDown: `The browser of the relay on ${e.HOST_LABEL} does not start`,
    },
  };
}

// The token the app sends with every call, written by scripts/relay-setup.mjs
export function readToken(file: string): string {
  let token = "";
  try {
    token = fs.readFileSync(file, "utf8").trim();
  } catch {
    // reported below
  }
  if (token.length < 24) throw new ConfigError(`no API token in ${file}: run npm run relay:setup`);
  return token;
}
