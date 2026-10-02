import fs from "node:fs";
import { z } from "zod";

// A setting that stops a process at start, with the reason: agent, supervisor, local relay, cmdapi, fleet agent
export class ConfigError extends Error {}

// The reasons a value did not pass, on one line
export const issuesText = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

// The variables of `schema`, checked once: an empty one (FOO= in a .env file) counts as unset, so its default applies
export function parseEnv<S extends z.ZodObject>(schema: S, env: Record<string, string | undefined>): z.output<S> {
  const given = Object.fromEntries(Object.keys(schema.shape).map((k) => [k, env[k] === "" ? undefined : env[k]]));
  const r = schema.safeParse(given);
  if (!r.success) throw new ConfigError(issuesText(r.error));
  return r.data;
}

// A JSON configuration file, parsed; `what` names it in the errors
export function readJsonFile(file: string, what: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new ConfigError(`${what} not found: ${file}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfigError(`${what} is not valid JSON: ${file}`);
  }
}

export const VapidSubject = z.string().regex(/^(mailto:|https:\/\/)/, "must be a mailto: or https:// URL").default("mailto:admin@example.com");
export const NtfyUrl = z.url({ protocol: /^https?$/ }).default("https://ntfy.sh");

// How the agents and the web app (for the accounts on another computer) reach the devices, set by docker-compose.yml
export const PushEnv = z.object({
  VAPID_PRIVATE: z.string().default("/vapid/private_key.pem"),
  VAPID_APPKEY: z.string().default("/vapid/appkey.txt"),
  VAPID_SUBJECT: VapidSubject,
  // service account key of the Firebase project (push to the Android app of mobile/); a missing file leaves FCM off
  FCM_CREDENTIALS: z.string().default("/fcm/service-account.json"),
  NTFY_ENABLED: z.enum(["0", "1"]).default("0"),
  NTFY_URL: NtfyUrl,
  NTFY_TOPIC: z.string().default(""),
});

export type PushSettings = {
  vapid: { privateKeyFile: string; appKeyFile: string; subject: string };
  fcmCredentials: string;
  ntfy: { url: string; topic: string } | null;
};

export function pushSettings(e: z.output<typeof PushEnv>): PushSettings {
  return {
    vapid: { privateKeyFile: e.VAPID_PRIVATE, appKeyFile: e.VAPID_APPKEY, subject: e.VAPID_SUBJECT },
    fcmCredentials: e.FCM_CREDENTIALS,
    ntfy: e.NTFY_ENABLED === "1" && e.NTFY_TOPIC ? { url: e.NTFY_URL, topic: e.NTFY_TOPIC } : null,
  };
}
