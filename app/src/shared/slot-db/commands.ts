import { z } from "zod";

// Commands the web app queues in the commands table and the agent runs on the Teams page.
// arg1 is the chat name (the file URL for download); arg2 is the text for send, JSON for the others below.
export const COMMAND_TYPES = ["open", "send", "reply", "react", "edit", "delete", "undodelete", "download", "activity", "resync", "recheck"] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const COMMAND_STATUSES = ["pending", "done", "failed"] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

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

// Result of a download, in the state row cmd_result:<id>: file name in data/N/files
export const DownloadResult = z.object({ f: z.string() });
export type DownloadResult = z.infer<typeof DownloadResult>;

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
