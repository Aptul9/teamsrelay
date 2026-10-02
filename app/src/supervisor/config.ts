import { z } from "zod";
import { parseEnv } from "@/shared/env";
import type { AccountsConfig } from "./accounts";

// Environment of the supervisor: the container environment (s6 with-contenv), set by the image and by
// docker-compose.yml. Checked once at start, like the agent's.
const Env = z.object({
  CONTROL_SOCKET: z.string().default("/root/run/control.sock"),
  PROFILES_DIR: z.string().default("/profiles"),
  DATA_DIR: z.string().default("/root/data"),
  VAPID_DIR: z.string().default("/root/vapid"),
  FCM_DIR: z.string().default("/root/fcm"),
  SLOT_COUNT: z.coerce.number().int().min(1).max(100).default(4),
  PUID: z.coerce.number().int().min(1).default(1000),
  PGID: z.coerce.number().int().min(1).default(1000),
  XDG_RUNTIME_DIR: z.string().default("/config/.XDG"),
  CHROMIUM: z.string().default("/usr/bin/chromium"),
  AGENT_SCRIPT: z.string().default("/app/agent.cjs"),
});

// passed on as they are, when set. PULSE_RUNTIME_PATH: where the image runs PulseAudio (/defaults/native), the sound of
// the desktop and the microphone Selkies forwards; without it Chromium looks in XDG_RUNTIME_DIR/pulse and finds none
const BROWSER_ENV = ["TZ", "LANG", "LANGUAGE", "LC_ALL", "PULSE_RUNTIME_PATH"];
const AGENT_ENV = ["TZ", "VAPID_SUBJECT", "NTFY_ENABLED", "NTFY_URL", "NTFY_TOPIC"];

export type SupervisorConfig = { socket: string; accounts: AccountsConfig };

export function loadConfig(env: Record<string, string | undefined> = process.env): SupervisorConfig {
  const e = parseEnv(Env, env);
  const pick = (names: string[]) => Object.fromEntries(names.flatMap((k) => (env[k] ? [[k, env[k]]] : [])));
  return {
    socket: e.CONTROL_SOCKET,
    accounts: {
      profilesDir: e.PROFILES_DIR,
      dataDir: e.DATA_DIR,
      vapidDir: e.VAPID_DIR,
      fcmDir: e.FCM_DIR,
      slotCount: e.SLOT_COUNT,
      uid: e.PUID,
      gid: e.PGID,
      chromium: e.CHROMIUM,
      agentScript: e.AGENT_SCRIPT,
      node: process.execPath,
      cdpBasePort: 9221,
      // Selkies of the image listens there, behind its nginx (/etc/nginx/sites-available/default)
      desktopPort: 8082,
      // the labwc session of the image (/defaults/startwm_wayland.sh): its clients connect to wayland-0
      session: { XDG_RUNTIME_DIR: e.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      browserEnv: pick(BROWSER_ENV),
      agentEnv: pick(AGENT_ENV),
      wlrctl: "wlrctl",
    },
  };
}
