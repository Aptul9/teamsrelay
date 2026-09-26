import { REACTIONS as REACTION_NAMES, type CommandType } from "@/shared/slot-db/commands";
import { appDb, isSlotStopped } from "./appdb";
import { HttpError } from "./http";
import { withSlot } from "./slotdb";

// Commands are rows in data/N/messages.db; the agent of slot N runs them on the Teams page. A stopped
// account has no agent to run them.
export function queue(slot: number, type: CommandType, arg1 = "", arg2 = ""): number {
  if (isSlotStopped(appDb(), slot)) throw new HttpError(409, "This Teams account is stopped: start it from the account menu");
  return withSlot(slot, (r) => r.enqueue(type, arg1, arg2));
}

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
