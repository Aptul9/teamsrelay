import type { CommandType } from "@/shared/slot-db/commands";
import { RelayLink, STATE } from "@/shared/slot-db/state";
import { appDb, slotRow } from "./appdb";
import { HttpError } from "./http";
import { withSlot } from "./slotdb";

// The checks of what the app sends, shared with the API of the local relay
export { chatName, mentionNames, messageArgs, messageId, messageText, reactArgs, REACTIONS, textArgs } from "@/shared/command-input";

// Why the account takes no command, null when it takes them: stopped by its owner, checked every N hours (its agent
// runs only during a check, which stops it right after reading), or on another computer whose relay is not connected
// (nothing would take the command before it is too old to run)
export function idleReason(slot: number): string | null {
  const s = slotRow(appDb(), slot);
  if (s?.stopped) return "This Teams account is stopped: start it from its page or from Settings";
  if (s?.check_every) return "This Teams account runs only during its checks: set it to always on in Settings to act on Teams";
  if (s?.relay) {
    const { agent, host } = withSlot(slot, (r) => ({ agent: r.health(0).agent, host: RelayLink.catch({ host: "", seen: 0 }).parse(r.state<unknown>(STATE.relay, {})).host }));
    if (agent !== "ok") return `The relay of this Teams account${host ? ` on ${host}` : ""} is not connected: start it on that computer`;
  }
  return null;
}

// Commands are rows in data/N/messages.db; the agent of slot N runs them on the Teams page. An account without a
// running agent refuses them.
export function queue(slot: number, type: CommandType, arg1 = "", arg2 = ""): number {
  const why = idleReason(slot);
  if (why) throw new HttpError(409, why);
  return withSlot(slot, (r) => r.enqueue(type, arg1, arg2));
}
