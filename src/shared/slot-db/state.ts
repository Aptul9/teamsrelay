import { z } from "zod";

// Keys of the state table (k TEXT, v TEXT). Values are plain text unless noted as JSON.
export const STATE = {
  // JSON AgentHealth, rewritten by the agent every ~5 s
  health: "health",
  // Teams status last logged
  presencePrev: "presence_prev",
  // JSON Watch of the Teams sign-in and of the browser: since when the problem lasts, whether it was pushed
  loginWatch: "login_watch",
  browserWatch: "browser_watch",
  // chat the agent keeps open in Teams for the app
  activeChat: "active_chat",
  // JSON Viewing: chat on screen in the app, written by the API while the app shows it and by the agent on commands
  viewing: "viewing",
  // JSON Identity of the signed-in Microsoft account
  me: "me",
  // Unix seconds of the last chat list read
  lastScanTs: "last_scan_ts",
} as const;

// "1" once the automatic check of that half day (YYYYMMDD, am or pm) ran
export const selfCheckKey = (day: string, half: "am" | "pm") => `hc_${day}_${half}`;

export const Viewing = z.object({ chat: z.string().catch(""), ts: z.number().catch(0) });
export type Viewing = z.infer<typeof Viewing>;

export const Watch = z.object({ since: z.number().catch(0), alerted: z.boolean().catch(false) });
export type Watch = z.infer<typeof Watch>;

export const Identity = z.object({
  name: z.string().catch(""),
  email: z.string().catch(""),
  tenant: z.string().catch(""),
  av: z.string().catch(""),
});
export type Identity = z.infer<typeof Identity>;

// teams as the agent writes it; the API adds "unknown" when the agent is silent
export const TEAMS_STATES = ["ok", "login", "loading", "err"] as const;
export type TeamsState = (typeof TEAMS_STATES)[number];

export const AgentHealth = z.object({
  // down: the browser does not start
  browser: z.enum(["ok", "down"]),
  ts: z.number(),
  teams: z.enum(TEAMS_STATES),
  reduced: z.boolean().optional(),
  hook: z.enum(["ok", "no"]).optional(),
  presence: z.string().optional(),
  push_subs: z.number().optional(),
  last_msg_ts: z.number().optional(),
  last_scan_ts: z.number().optional(),
  watcher: z.enum(["ok", "stale"]).optional(),
  overall: z.enum(["green", "yellow", "red"]),
});
export type AgentHealth = z.infer<typeof AgentHealth>;

// Health as the API serves it: the agent's, plus agent, whether the agent still writes it
export type ServedHealth = Partial<Omit<AgentHealth, "teams">> & { teams?: string; agent?: "ok" | "stale" };

// JSON of a state row; missing, broken or of another shape gives the fallback
export function parseState<T>(schema: z.ZodType<T>, value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const r = schema.safeParse(JSON.parse(value));
    return r.success ? r.data : fallback;
  } catch {
    return fallback;
  }
}
