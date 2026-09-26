import { HttpError } from "./http-error";
import { REACTIONS as REACTION_NAMES, type MessageArgs, type ReactArgs, type TextArgs } from "./slot-db/commands";

// What an app sends with a command, checked the same way by the web app (one route per command) and by the API of
// the local relay (one route for all of them): a value that does not pass is a 400 with the reason, and nothing is
// queued. The arguments come out as the agent reads them (arg2, src/shared/slot-db/commands.ts).

export function chatName(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 200) throw new HttpError(400, "Invalid chat name");
  return v;
}

export function messageId(v: unknown): string {
  if (typeof v !== "string" || !v || v.length > 100) throw new HttpError(400, "Invalid message id");
  return v;
}

export function messageText(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, "Empty text");
  if (v.length > 20000) throw new HttpError(400, "Text too long");
  return v;
}

// People tagged with @ in a message: up to 20 names as the members list shows them
export function mentionNames(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 20 || !v.every((n) => typeof n === "string" && n.trim() && n.length <= 100 && !/[\n@]/.test(n))) {
    throw new HttpError(400, "Invalid mentions");
  }
  return v as string[];
}

export const REACTIONS = new Set<string>(REACTION_NAMES);

// delete, undodelete
export const messageArgs = (mid: unknown) => JSON.stringify({ mid: messageId(mid) } satisfies MessageArgs);

// reply, edit
export const textArgs = (mid: unknown, text: unknown) => JSON.stringify({ mid: messageId(mid), text: messageText(text) } satisfies TextArgs);

// react. emoji: one of the six quick reactions. pill: the emoji of a reaction already under the message, clicked like
// in Teams (removed if it is yours, added otherwise).
export function reactArgs(mid: unknown, emoji: unknown, pill: unknown): string {
  const id = messageId(mid);
  if (pill) {
    if (typeof pill !== "string" || pill.length > 16) throw new HttpError(400, "Invalid reaction");
    return JSON.stringify({ mid: id, pill } satisfies ReactArgs);
  }
  if (typeof emoji !== "string" || !REACTIONS.has(emoji)) throw new HttpError(400, "Unsupported reaction");
  return JSON.stringify({ mid: id, emoji } satisfies ReactArgs);
}
