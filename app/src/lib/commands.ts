import { commandOf, type AppCommand } from "@/shared/command-input";
import type { CommandType } from "@/shared/slot-db/commands";
import { appDb, slotRow } from "./appdb";
import { body, HttpError, route } from "./http";
import { requireSlot } from "./session";
import { withSlot } from "./slotdb";

// Why the account takes no command, null when it takes them: stopped by its owner, checked every N hours (its agent
// runs only during a check, which stops it right after reading), or on another computer whose relay is not connected
// (nothing would take the command before it is too old to run)
export function idleReason(slot: number): string | null {
  const s = slotRow(appDb(), slot);
  if (s?.stopped) return "This Teams account is stopped: start it from its page or from Settings";
  if (s?.check_every) return "This Teams account runs only during its checks: set it to always on in Settings to act on Teams";
  if (s?.relay) {
    const { agent, host } = withSlot(slot, (r) => ({ agent: r.health(0).agent, host: r.relayLink().host }));
    if (agent !== "ok") return `The relay of this Teams account${host ? ` on ${host}` : ""} is not connected: start it on that computer`;
  }
  return null;
}

// Commands are rows in data/N/messages.db; the agent of slot N runs them on the Teams page. An account without a
// running agent refuses them.
export function queue(slot: number, type: CommandType, arg1 = "", arg2 = ""): number {
  takesCommands(slot);
  return withSlot(slot, (r) => r.enqueue(type, arg1, arg2));
}

// The same, but a request sent again while its command still waits (a double tap) gets that command
export function queueOnce(slot: number, type: CommandType, arg1 = "", arg2 = ""): number {
  takesCommands(slot);
  return withSlot(slot, (r) => r.enqueueOnce(type, arg1, arg2));
}

function takesCommands(slot: number) {
  const why = idleReason(slot);
  if (why) throw new HttpError(409, why);
}

// The route of a command made of what the app sends alone, the chat named `name` as the web app always called it
export const commandRoute = (type: Exclude<AppCommand, "send" | "resync" | "recheck">) =>
  route(async (req) => {
    const { slot } = await requireSlot(req);
    const b = await body(req);
    const c = commandOf({ ...b, type, chat: b.name });
    return Response.json({ ok: true, id: queue(slot, c.type, c.arg1, c.arg2) });
  });
