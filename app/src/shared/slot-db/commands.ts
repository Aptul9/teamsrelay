import { z } from "zod";

// Commands the web app queues in the commands table and the agent runs on the Teams page.
// arg1 is the chat name (the file URL for download); arg2 is the text for send, JSON for the others below.
// New types go at the end, names never change: an agent of an earlier release ends an unknown type as done.
export const COMMAND_TYPES = [
  "open",
  "send",
  "reply",
  "react",
  "edit",
  "delete",
  "undodelete",
  "download",
  "activity",
  "resync",
  "recheck",
  "sendimage",
  "members",
  "sendmentions",
  // an account checked every N hours: the whole chat list and the Activity feed, then one push if something is new
  "check",
  // the incoming call (arg1 the caller, AnswerArgs) and the call in progress: run by the call watch of the agent, not
  // by the loop, since a round of the loop can take longer than a call rings
  "answer",
  "hangup",
  // Teams' own mute of the call in progress (arg1 the caller, MuteArgs), run by the call watch as well
  "mute",
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const CALL_COMMANDS: readonly CommandType[] = ["answer", "hangup", "mute"];

// pending: queued; done: Teams shows the change; failed: not applied on Teams. Later additions, written by the agent
// only: running, on Teams now; unconfirmed, the agent stopped while it ran and does not run it again, as it may
// have reached Teams already. The web app reports them as pending and failed (src/lib/slotdb.ts).
export const COMMAND_STATUSES = ["pending", "done", "failed", "running", "unconfirmed"] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

// Key an app may give a command (commands.key): the same key queues it once, so an app that sends a command again
// because the answer got lost on the way does not queue it twice
export const COMMAND_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export const REACTIONS = ["like", "heart", "laugh", "surprised", "cry", "angry"] as const;
export type ReactionName = (typeof REACTIONS)[number];

// A field of the wrong type reads as empty, as a missing one: the command then fails on Teams, not in parsing
const text = z.string().catch("");

// delete, undodelete
export const MessageArgs = z.object({ mid: text });
export type MessageArgs = z.infer<typeof MessageArgs>;

// reply, edit
export const TextArgs = z.object({ mid: text, text });
export type TextArgs = z.infer<typeof TextArgs>;

// react: one of REACTIONS in emoji, or pill, the emoji of a reaction already under the message
export const ReactArgs = z.object({ mid: text, emoji: text.optional(), pill: text.optional() });
export type ReactArgs = z.infer<typeof ReactArgs>;

export const DownloadArgs = z.object({ name: text });
export type DownloadArgs = z.infer<typeof DownloadArgs>;

// sendimage: file in data/N/uploads, written by the web app and deleted by the agent once sent; text is the
// caption, possibly empty
export const ImageArgs = z.object({ file: text, text });
export type ImageArgs = z.infer<typeof ImageArgs>;

// sendmentions: the message in order, text and people tagged with @ (their names as the members list shows them).
// members (arg1 the chat) needs no argument: the names go to the state row members:<chat>.
const MentionPart = z.union([z.object({ text: z.string() }), z.object({ mention: z.string() })]);
export type MentionPart = z.infer<typeof MentionPart>;
export const MentionArgs = z.object({ parts: z.array(MentionPart).catch([]) });
export type MentionArgs = z.infer<typeof MentionArgs>;

// answer: the call, by when it started ringing (since of the call state, ms)
export const AnswerArgs = z.object({ since: z.number().catch(0) });
export type AnswerArgs = z.infer<typeof AnswerArgs>;

// mute: the state asked for, muted (true) or not; the shortcut of Teams toggles, so a state, never a toggle. Anything
// else is null, which the agent refuses: a broken command never unmutes.
export const MuteArgs = z.object({ on: z.boolean().nullable().catch(null) });
export type MuteArgs = z.infer<typeof MuteArgs>;

// Images the app can send, by file extension
export const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;
export type ImageExt = keyof typeof IMAGE_TYPES;
export const UPLOAD_NAME = /^[0-9a-f]{16}\.(png|jpg|gif|webp)$/;

// Result of a download, in the state row cmd_result:<id>: file name in data/N/files
export const DownloadResult = z.object({ f: z.string() });
export type DownloadResult = z.infer<typeof DownloadResult>;

// Why Teams did not show the chat an open asked for: no row of that name in its list, or a row clicked that showed
// another chat
export const OPEN_PROBLEMS = ["not-listed", "not-shown"] as const;
export type OpenProblem = (typeof OPEN_PROBLEMS)[number];
// Result of an open that failed, in the state row cmd_result:<id>: Teams signed out or still loading (nothing
// touched), the chat not shown, or shown with messages that could not be read. An open that failed without one
// waited too long or was cut by a restart of the agent.
export const OPEN_REASONS = ["signed-out", "loading", ...OPEN_PROBLEMS, "unreadable"] as const;
export type OpenReason = (typeof OPEN_REASONS)[number];
export const OpenResult = z.object({ reason: z.enum(OPEN_REASONS) });
export type OpenResult = z.infer<typeof OpenResult>;
// The last open of a chat as the app follows it, in the messages event of the event stream (src/lib/slotdb.ts)
export type OpenStatus = { id: number; status: "pending" | "done" | "failed"; reason?: OpenReason };

// arg2 that is not JSON, or not an object, gives the empty arguments
export function parseArgs<T>(schema: z.ZodType<T>, arg2: string | null | undefined): T {
  let value: unknown = {};
  try {
    value = JSON.parse(arg2 || "{}");
  } catch {
    value = {};
  }
  const r = schema.safeParse(value);
  return r.success ? r.data : schema.parse({});
}
