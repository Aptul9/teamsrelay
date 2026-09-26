import { z } from "zod";

// Keys of the state table (k TEXT, v TEXT). Values are plain text unless noted as JSON.
export const STATE = {
  // JSON AgentHealth, rewritten by the agent every ~5 s
  health: "health",
  // Teams status last logged, and Teams state (ok, login...) at the previous health check
  presencePrev: "presence_prev",
  teamsStatusPrev: "teams_status_prev",
  // chat the agent keeps open in Teams for the app
  activeChat: "active_chat",
  // JSON Viewing: chat on screen in the app, written by the web app while it shows it and by the agent on commands
  viewing: "viewing",
  // JSON Identity of the signed-in Microsoft account
  me: "me",
  // Unix seconds of the last Activity feed and chat list reads
  activityTs: "activity_ts",
  lastScanTs: "last_scan_ts",
} as const;

// JSON result of command <id>, e.g. DownloadResult
export const cmdResultKey = (id: number) => `cmd_result:${id}`;
// "1": 1:1 chat, where Teams has no "Read by" entry
export const oneToOneKey = (chat: string) => `chat_1to1:${chat}`;
// JSON Members of a chat, read by the agent on a members command
export const membersKey = (chat: string) => `members:${chat}`;
// "1" once the automatic check of that half day (YYYYMMDD, am or pm) ran
export const selfCheckKey = (day: string, half: "am" | "pm") => `hc_${day}_${half}`;

export const Viewing = z.object({ chat: z.string().catch(""), ts: z.number().catch(0) });
export type Viewing = z.infer<typeof Viewing>;

// People of a chat as Teams names them, for the @ of the app; ts: Unix seconds of the read
export const Members = z.object({ ts: z.number().catch(0), names: z.array(z.string()).catch([]) });
export type Members = z.infer<typeof Members>;

export const Identity = z.object({
  name: z.string().catch(""),
  email: z.string().catch(""),
  tenant: z.string().catch(""),
  av: z.string().catch(""),
});
export type Identity = z.infer<typeof Identity>;

// teams as the agent writes it; the web app adds "starting" and "unknown" when the agent is silent
export const TEAMS_STATES = ["ok", "login", "loading", "err"] as const;
export type TeamsState = (typeof TEAMS_STATES)[number];

export const AgentHealth = z.object({
  cdp: z.literal("ok"),
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

// Health as the web app serves it (/api/health, health event): the agent's, plus agent, whether the agent
// still writes it; teams also takes "starting" and "unknown" there. A slot its owner stopped is "stopped"
// and grey, whatever its agent wrote last.
export type SlotHealth = Partial<Omit<AgentHealth, "teams" | "watcher" | "overall">> & {
  teams?: string;
  agent?: "ok" | "stale" | "stopped";
  watcher?: "ok" | "stale" | "stopped";
  overall?: AgentHealth["overall"] | "grey";
};

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
