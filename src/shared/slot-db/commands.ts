import { z } from "zod";

// Commands the API queues in the commands table and the agent runs on the Teams page.
// arg1 is the chat name; arg2 is the text for send, JSON for the others below.
// New types go at the end, names never change: an agent of an earlier release ends an unknown type as done.
export const COMMAND_TYPES = ["open", "send", "reply", "react", "edit", "delete", "undodelete", "resync", "recheck"] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

// pending: queued; running: on Teams now; done; failed: not applied on Teams; unconfirmed: applied (a message typed and
// sent) but Teams did not show it done in time, or the relay stopped while it ran: it may have gone out
export const COMMAND_STATUSES = ["pending", "running", "done", "failed", "unconfirmed"] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

// Key the app gives a command so that sending it again (answer lost on the phone's network) does not queue it twice
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

// arg2 that is not JSON, or not an object, gives the empty arguments
export function parseArgs<T>(schema: z.ZodType<T>, arg2: string | null | undefined): T {
  let value: unknown;
  try {
    value = JSON.parse(arg2 || "{}");
  } catch {
    value = {};
  }
  const r = schema.safeParse(value);
  return r.success ? r.data : schema.parse({});
}
