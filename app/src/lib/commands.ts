import type { CommandType } from "@/shared/slot-db/commands";
import { appDb, slotRow } from "./appdb";
import { HttpError } from "./http";
import { withSlot } from "./slotdb";

// The checks of what the app sends, shared with the API of the local relay
export { chatName, mentionNames, messageArgs, messageId, messageText, reactArgs, REACTIONS, textArgs } from "@/shared/command-input";

// Why the account takes no command, null when it takes them: stopped by its owner, or checked every N hours (its agent
// runs only during a check, which stops it right after reading)
export function idleReason(slot: number): string | null {
  const s = slotRow(appDb(), slot);
  if (s?.stopped) return "This Teams account is stopped: start it from the account menu";
  if (s?.check_every) return "This Teams account runs only during its checks: set it to always on in Settings to act on Teams";
  return null;
}

// Commands are rows in data/N/messages.db; the agent of slot N runs them on the Teams page. An account without a
// running agent refuses them.
export function queue(slot: number, type: CommandType, arg1 = "", arg2 = ""): number {
  const why = idleReason(slot);
  if (why) throw new HttpError(409, why);
  return withSlot(slot, (r) => r.enqueue(type, arg1, arg2));
}
