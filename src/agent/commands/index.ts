import type { CommandStatus, CommandType } from "@/shared/slot-db/commands";
import type { Agent } from "../context";
import { scanChats } from "../jobs/chat-list";
import { errorText, log } from "../log";
import type { PendingCommand } from "../store/slot-store";
import { deleteCommand } from "./delete";
import { edit } from "./edit";
import { open } from "./open";
import { react } from "./react";
import { recheck } from "./recheck";
import { reply } from "./reply";
import { resync } from "./resync";
import { send } from "./send";
import { undoDelete } from "./undo-delete";

export type Outcome = Exclude<CommandStatus, "pending">;
export type Handler = (a: Agent, cmd: PendingCommand) => Promise<Outcome>;

// Seconds a command may wait for the agent: older ones end as failed without touching Teams
export const COMMAND_MAX_AGE = 120;

// One handler per command type of the API (src/shared/slot-db/commands.ts)
export const HANDLERS: Record<CommandType, Handler> = {
  open,
  send,
  reply,
  react,
  edit,
  delete: deleteCommand,
  undodelete: undoDelete,
  resync,
  recheck,
};

// open, resync and recheck end as done whatever happened on Teams; an unknown type ends as done too. A handler
// that throws: failed, and the command is not run again.
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

// Every pending command, oldest first. The outcome is written after the new state is saved: the API reads again
// as soon as it sees done. Commands can take seconds: the chat list is read after each one.
export async function runPendingCommands(a: Agent) {
  const expired = a.store.expirePendingCommands(COMMAND_MAX_AGE);
  if (expired) log.warn("cmd", "waited too long, not run", { commands: expired });
  for (const cmd of a.store.pendingCommands()) {
    log.info("CMD", cmd.type, { id: cmd.id, arg: cmd.arg1 });
    a.store.finishCommand(cmd.id, await runCommand(a, cmd));
    await scanChats(a);
  }
}
