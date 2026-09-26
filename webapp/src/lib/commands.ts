import { appDb, isSlotStopped } from "./appdb";
import { HttpError } from "./http";
import { withSlot } from "./slotdb";

// Commands are rows in data/N/messages.db; the agent of slot N runs them on the Teams page. A stopped
// account has no agent to run them.
export function queue(slot: number, type: string, arg1 = "", arg2 = ""): number {
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

export const REACTIONS = new Set(["like", "heart", "laugh", "surprised", "cry", "angry"]);
