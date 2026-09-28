import { CALL_COMMANDS, type CommandStatus, type CommandType } from "@/shared/slot-db/commands";
import type { Agent } from "../context";
import { scanChats } from "../jobs/chat-list";
import { errorText, log } from "../log";
import type { PendingCommand } from "../store/slot-store";
import { activity } from "./activity";
import { check } from "./check";
import { deleteCommand } from "./delete";
import { download } from "./download";
import { edit } from "./edit";
import { members } from "./members";
import { open } from "./open";
import { react } from "./react";
import { recheck } from "./recheck";
import { reply } from "./reply";
import { resync } from "./resync";
import { send } from "./send";
import { sendMentions } from "./send-mentions";
import { sendImageCommand } from "./send-image";
import { undoDelete } from "./undo-delete";

export type Outcome = Exclude<CommandStatus, "pending" | "running">;
export type Handler = (a: Agent, cmd: PendingCommand) => Promise<Outcome>;

// Seconds a command may wait for the agent: older ones end as failed without touching Teams
export const COMMAND_MAX_AGE = 120;

// The call watch runs answer and hangup (src/agent/jobs/calls.ts): here they end as failed, with nothing done
const byCallWatch: Handler = async () => "failed";

// One handler per command type of the web app and of the local relay (src/shared/slot-db/commands.ts)
export const HANDLERS: Record<CommandType, Handler> = {
  open,
  send,
  reply,
  react,
  edit,
  delete: deleteCommand,
  undodelete: undoDelete,
  download,
  activity,
  resync,
  recheck,
  sendimage: sendImageCommand,
  members,
  sendmentions: sendMentions,
  check,
  answer: byCallWatch,
  hangup: byCallWatch,
};

// open, resync and recheck end as done whatever happened on Teams, like in the Python agent; an unknown type ends
// as done too. A handler that throws: failed, and the command is not run again.
export async function runCommand(a: Agent, cmd: PendingCommand): Promise<Outcome> {
  const handler = HANDLERS[cmd.type as CommandType] as Handler | undefined;
  if (!handler) return "done";
  try {
    return await handler(a, cmd);
  } catch (e) {
    log.warn("cmd", errorText(e), { id: cmd.id, type: cmd.type });
    return "failed";
  }
}

// Every pending command, oldest first, marked running while it runs. The outcome is written after the new state is
// saved: the app reads again as soon as it sees done. Commands can take seconds: the chat list is read after each
// one. Nothing runs between two calls, so a command still running here was left by an agent that stopped.
export async function runPendingCommands(a: Agent) {
  const interrupted = a.store.interruptedCommands();
  if (interrupted) log.warn("cmd", "stopped while running, not run again: unconfirmed", { commands: interrupted });
  for (const cmd of a.store.pendingCommands()) {
    // the commands before this one may have taken minutes: its age counts when its turn comes
    const expired = a.store.expirePendingCommands(COMMAND_MAX_AGE);
    if (expired) log.warn("cmd", "waited too long, not run", { commands: expired });
    if (a.store.commandStatus(cmd.id) !== "pending") continue;
    // the call watch takes them at its next look, within a second: a call rings a few seconds only
    if (CALL_COMMANDS.includes(cmd.type as CommandType)) continue;
    // a refresh of the Activity feed, or a check, stays pending until the health check finds the side bar clickable:
    // while Teams starts (sign-in redirects, then its loading bar) the clicks would time out
    if ((cmd.type === "activity" || cmd.type === "check") && !a.railReady) continue;
    log.info("CMD", cmd.type, { id: cmd.id, arg: cmd.type === "download" ? undefined : cmd.arg1 });
    a.store.startCommand(cmd.id);
    a.store.finishCommand(cmd.id, await runCommand(a, cmd));
    await scanChats(a);
  }
}
