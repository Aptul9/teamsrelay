import path from "node:path";
import { z } from "zod";
import type { AgentSettings } from "./context";

// Environment of the agent of one slot, set by docker-compose.yml. Checked once at start: a wrong value stops
// the agent with the reason, instead of a failure later on the Teams page.
const Env = z.object({
  // 127.0.0.1, not localhost, in the containers: Chromium binds CDP on IPv4 only, localhost resolves to ::1 first
  CDP: z.url({ protocol: /^https?$/ }).default("http://localhost:9222"),
  ACCOUNT: z.coerce.number().int().min(1).default(1),
  DB_PATH: z.string().default("/data/1/messages.db"),
  APP_DB: z.string().default("/data/app.db"),
  VAPID_PRIVATE: z.string().default("/vapid/private_key.pem"),
  VAPID_APPKEY: z.string().default("/vapid/appkey.txt"),
  VAPID_SUBJECT: z.string().regex(/^(mailto:|https:\/\/)/, "must be a mailto: or https:// URL").default("mailto:admin@example.com"),
  // service account key of the Firebase project (push to the Android app of mobile/); a missing file leaves FCM off
  FCM_CREDENTIALS: z.string().default("/fcm/service-account.json"),
  NTFY_ENABLED: z.enum(["0", "1"]).default("0"),
  NTFY_URL: z.url({ protocol: /^https?$/ }).default("https://ntfy.sh"),
  NTFY_TOPIC: z.string().default(""),
  // the remote desktop of the browsers container, given by the supervisor: the port of its websocket, the desktop
  // user and session (wlrctl), the app id of this account's window. Unset: nothing watched (a slot run by hand).
  DESKTOP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  DESKTOP_UID: z.coerce.number().int().min(0).optional(),
  DESKTOP_GID: z.coerce.number().int().min(0).optional(),
  DESKTOP_APP_ID: z.string().optional(),
  XDG_RUNTIME_DIR: z.string().optional(),
  WAYLAND_DISPLAY: z.string().optional(),
});

export type Config = AgentSettings & {
  cdp: string;
  slot: number;
  dbPath: string;
  appDb: string;
  // images and profile pictures, downloaded attachments, images the web app queued to send: next to the slot
  // database
  mediaDir: string;
  filesDir: string;
  vapid: { privateKeyFile: string; appKeyFile: string; subject: string };
  fcmCredentials: string;
  ntfy: { url: string; topic: string } | null;
};

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // an empty variable (FOO= in .env) counts as unset
  const given = Object.fromEntries(Object.keys(Env.shape).map((k) => [k, env[k] === "" ? undefined : env[k]]));
  const r = Env.safeParse(given);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const e = r.data;
  const dataDir = path.dirname(e.DB_PATH);
  return {
    cdp: e.CDP,
    slot: e.ACCOUNT,
    dbPath: e.DB_PATH,
    appDb: e.APP_DB,
    mediaDir: path.join(dataDir, "media"),
    filesDir: path.join(dataDir, "files"),
    uploadsDir: path.join(dataDir, "uploads"),
    vapid: { privateKeyFile: e.VAPID_PRIVATE, appKeyFile: e.VAPID_APPKEY, subject: e.VAPID_SUBJECT },
    fcmCredentials: e.FCM_CREDENTIALS,
    desktop:
      e.DESKTOP_PORT && e.DESKTOP_UID !== undefined && e.DESKTOP_GID !== undefined && e.DESKTOP_APP_ID && e.XDG_RUNTIME_DIR && e.WAYLAND_DISPLAY
        ? { port: e.DESKTOP_PORT, uid: e.DESKTOP_UID, gid: e.DESKTOP_GID, appId: e.DESKTOP_APP_ID, session: { XDG_RUNTIME_DIR: e.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: e.WAYLAND_DISPLAY } }
        : null,
    ntfy: e.NTFY_ENABLED === "1" && e.NTFY_TOPIC ? { url: e.NTFY_URL, topic: e.NTFY_TOPIC } : null,
    // the web app shows both
    activity: true,
    readBy: true,
    // the sound of a call goes through the remote desktop of the browsers container
    answerCalls: true,
    alerts: {
      signInAfter: 60,
      browserAfter: 300,
      signIn: "Open the remote desktop of the account and sign in again",
      browserDown: `The browser of account ${e.ACCOUNT} does not start`,
    },
  };
}
