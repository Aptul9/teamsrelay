import { z } from "zod";

// Keys of the state table (k TEXT, v TEXT). Values are plain text unless noted as JSON.
export const STATE = {
  // JSON AgentHealth, rewritten by the agent every ~5 s
  health: "health",
  // Teams status last logged, and Teams state (ok, login...) at the previous health check
  presencePrev: "presence_prev",
  teamsStatusPrev: "teams_status_prev",
  // the owner's own presence now, as a Presence word (shared/presence), "" when unknown: the dot on the owner's avatar
  presence: "presence",
  // JSON Watch of the Teams sign-in and of the browser: since when the problem lasts, whether it was pushed
  loginWatch: "login_watch",
  browserWatch: "browser_watch",
  // chat the agent keeps open in Teams for the app
  activeChat: "active_chat",
  // JSON Viewing: chat on screen in the app, written by the web app while it shows it and by the agent on commands
  viewing: "viewing",
  // JSON Identity of the signed-in Microsoft account
  me: "me",
  // Unix seconds of the last Activity feed and chat list reads
  activityTs: "activity_ts",
  lastScanTs: "last_scan_ts",
  // JSON {chats, activity, calls, feed, read}: what the last check of an account checked every N hours found
  // (src/agent/commands/check.ts)
  checkSeen: "check_seen",
  // JSON string[]: ids of the missed calls of the feed an account always on already alerted, newest first
  // (src/agent/jobs/missed-calls.ts)
  callsTold: "calls_told",
  // JSON CallState: the incoming call Teams shows, written by the agent while it rings and once it ends
  call: "call",
  // JSON InCall: the call in progress, written by the agent while the Teams page records from the microphone
  inCall: "in_call",
  // JSON RelayLink: an account on another computer, written by the web app at each sync of its relay (src/lib/relay.ts)
  relay: "relay",
  // JSON Desktop: when the owner opened the remote desktop of the account from the app (/api/desktop/N); the agent
  // leaves Teams to the owner for a while (src/agent/logic/owner.ts)
  desktop: "desktop",
  // JSON SignInTry: the one press of Sign in of the last sign-out (src/agent/jobs/sign-in.ts)
  signInTry: "sign_in_try",
  // 1: the relay of an account on another computer carries the sound of a call answered or placed from the app to the
  // app (src/local/call-bridge.ts); a relay of before never writes it
  callAudio: "call_audio",
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

// ts: Unix seconds
export const Desktop = z.object({ ts: z.number().catch(0) });
export type Desktop = z.infer<typeof Desktop>;

export const Watch = z.object({ since: z.number().catch(0), alerted: z.boolean().catch(false) });
export type Watch = z.infer<typeof Watch>;

// The attempt of a sign-out: when it started (Unix s, 0 none), what it pressed (teams: Teams' own Sign in, account: the
// tile of this account on Microsoft's page, button: Sign in or Continue there), whether Microsoft's page was dealt with
// (pressed, or it asked for something to type, or the owner was on it)
export const SignInTry = z.object({
  at: z.number().catch(0),
  pressed: z.array(z.enum(["teams", "account", "button"])).catch([]),
  microsoft: z.boolean().catch(false),
});
export type SignInTry = z.infer<typeof SignInTry>;

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

// The incoming call of the account (src/agent/jobs/calls.ts). since: when it started ringing, seen: the last time the
// agent saw it ringing, ms on the wall clock. While it rings the agent writes it again every CALL_SEEN_EVERY seconds,
// for as long as it pushes the call; the web app rings while the last write is at most CALL_FRESH_FOR seconds old, so
// the ring stops soon after an agent that stopped or a page that went away.
export const CallState = z.object({
  caller: z.string().catch(""),
  since: z.number().catch(0),
  seen: z.number().catch(0),
  ringing: z.boolean().catch(false),
});
export type CallState = z.infer<typeof CallState>;
export const CALL_SEEN_EVERY = 2;
export const CALL_FRESH_FOR = 10;

// The relay of an account on another computer: the name of that computer (HOST_LABEL), Unix seconds of its last sync
export const RelayLink = z.object({ host: z.string().catch(""), seen: z.number().catch(0) });
export type RelayLink = z.infer<typeof RelayLink>;

// The call in progress of the account (src/agent/jobs/calls.ts): caller and since of the call answered, seen: the last
// time the agent saw the page record from the microphone (ms on the wall clock), rewritten every CALL_SEEN_EVERY
// seconds while it does; active false once it stopped. muted: Teams' own mute of the call, what the others see,
// absent while the agent cannot read it (rewritten at once when it changes).
export const InCall = z.object({
  caller: z.string().catch(""),
  since: z.number().catch(0),
  seen: z.number().catch(0),
  active: z.boolean().catch(false),
  muted: z.boolean().optional().catch(undefined),
});
export type InCall = z.infer<typeof InCall>;

// A call of an account of the user (acc: its slot), as the event stream sends it to the app: ringing now, or in
// progress (active), with Teams' own mute state when known
export type RingingCall = { acc: number; caller: string; since: number; active?: boolean; muted?: boolean };

// The call the account is ringing with now, if any
export function ringingCall(c: CallState | null, now: number): { caller: string; since: number } | null {
  if (!c?.ringing || now - c.seen > CALL_FRESH_FOR * 1000) return null;
  return { caller: c.caller, since: c.since };
}

// The call in progress of the account, if any: the agent saw it a moment ago
export function inCallOf(c: InCall | null, now: number): { caller: string; since: number; muted?: boolean } | null {
  if (!c?.active || now - c.seen > CALL_FRESH_FOR * 1000) return null;
  return c.muted === undefined ? { caller: c.caller, since: c.since } : { caller: c.caller, since: c.since, muted: c.muted };
}

// teams as the agent writes it; the web app adds "starting" and "unknown" when the agent is silent
export const TEAMS_STATES = ["ok", "login", "loading", "err"] as const;
export type TeamsState = (typeof TEAMS_STATES)[number];

export const AgentHealth = z.object({
  // cdp is always ok, kept for the readers of earlier releases. browser is down only in the rows of the local relay
  // while it cannot start its browser: the agent of a slot writes nothing while it waits for its browser.
  cdp: z.literal("ok"),
  browser: z.enum(["ok", "down"]).optional(),
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
  // the owner uses Teams (remote desktop, window of the local relay): the agent moves it nowhere on its own
  desktop: z.literal("in-use").optional(),
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
