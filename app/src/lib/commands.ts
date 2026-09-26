import type { CommandType } from "@/shared/slot-db/commands";
import { appDb, isSlotStopped } from "./appdb";
import { HttpError } from "./http";
import { withSlot } from "./slotdb";

// The checks of what the app sends, shared with the API of the local relay
export { chatName, mentionNames, messageArgs, messageId, messageText, reactArgs, REACTIONS, textArgs } from "@/shared/command-input";

// Commands are rows in data/N/messages.db; the agent of slot N runs them on the Teams page. A stopped
// account has no agent to run them.
export function queue(slot: number, type: CommandType, arg1 = "", arg2 = ""): number {
  if (isSlotStopped(appDb(), slot)) throw new HttpError(409, "This Teams account is stopped: start it from the account menu");
  return withSlot(slot, (r) => r.enqueue(type, arg1, arg2));
}
