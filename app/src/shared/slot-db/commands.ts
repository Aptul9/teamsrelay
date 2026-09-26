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
] as const;
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

// Images the app can send, by file extension
export const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;
export type ImageExt = keyof typeof IMAGE_TYPES;
export const UPLOAD_NAME = /^[0-9a-f]{16}\.(png|jpg|gif|webp)$/;

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
