import { HttpError } from "./http-error";
import { REACTIONS as REACTION_NAMES, type CommandType, type MessageArgs, type ReactArgs, type TextArgs } from "./slot-db/commands";

// What an app sends with a command, checked the same way by the web app (one route per command) and by the API of
// the local relay (one route for all of them): a value that does not pass is a 400 with the reason, and nothing is
// queued. The arguments come out as the agent reads them (arg2, src/shared/slot-db/commands.ts).

export function chatName(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 200) throw new HttpError(400, "Invalid chat name");
  return v;
}

function messageId(v: unknown): string {
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

const REACTIONS = new Set<string>(REACTION_NAMES);

// delete, undodelete
const messageArgs = (mid: unknown) => JSON.stringify({ mid: messageId(mid) } satisfies MessageArgs);

// reply, edit
const textArgs = (mid: unknown, text: unknown) => JSON.stringify({ mid: messageId(mid), text: messageText(text) } satisfies TextArgs);

// react. emoji: one of the six quick reactions. pill: the emoji of a reaction already under the message, clicked like
// in Teams (removed if it is yours, added otherwise).
function reactArgs(mid: unknown, emoji: unknown, pill: unknown): string {
  const id = messageId(mid);
  if (pill) {
    if (typeof pill !== "string" || pill.length > 16) throw new HttpError(400, "Invalid reaction");
    return JSON.stringify({ mid: id, pill } satisfies ReactArgs);
  }
  if (typeof emoji !== "string" || !REACTIONS.has(emoji)) throw new HttpError(400, "Unsupported reaction");
  return JSON.stringify({ mid: id, emoji } satisfies ReactArgs);
}

// The commands an app sends with nothing but what it typed or tapped: the relay takes them all on one route (POST
// /api/cmd, src/local/server.ts), the web app on one route each (commandRoute, src/lib/commands.ts)
export const APP_COMMANDS = ["open", "send", "reply", "react", "edit", "delete", "undodelete", "resync", "recheck"] as const satisfies readonly CommandType[];
export type AppCommand = (typeof APP_COMMANDS)[number];

// The command of such a body as the agent reads it (arg1, arg2); 400 when it is not one
export function commandOf(b: Record<string, unknown>): { type: AppCommand; arg1: string; arg2: string } {
  const type = b.type as AppCommand;
  if (typeof type !== "string" || !(APP_COMMANDS as readonly string[]).includes(type)) throw new HttpError(400, "Unknown command");
  switch (type) {
    case "open":
      return { type, arg1: chatName(b.chat), arg2: "" };
    case "send":
      return { type, arg1: chatName(b.chat), arg2: messageText(b.text) };
    case "reply":
    case "edit":
      return { type, arg1: chatName(b.chat), arg2: textArgs(b.mid, b.text) };
    case "delete":
    case "undodelete":
      return { type, arg1: chatName(b.chat), arg2: messageArgs(b.mid) };
    case "react":
      return { type, arg1: chatName(b.chat), arg2: reactArgs(b.mid, b.emoji, b.pill) };
    case "resync":
    case "recheck":
      return { type, arg1: "", arg2: "" };
  }
}
