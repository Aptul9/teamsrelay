import type { OpenReason, OpenResult } from "@/shared/slot-db/commands";
import { cmdResultKey, STATE } from "@/shared/slot-db/state";
import type { Agent } from "../context";
import { markViewing, saveOpenChat } from "../jobs/conversation";
import type { Handler, Outcome } from "./index";

// arg1: chat. The app shows the chat: Teams opens it and the agent saves its messages. Done once they are saved, so
// the app can tell the messages of this visit from the ones saved at the last one; failed otherwise, with the reason in
// cmd_result:<id>. While Teams is signed out nothing is touched: there is no chat list to click in (while it loads, the
// open waits in the queue: runPendingCommands).
export const open: Handler = async (a, { id, arg1: chat }) => {
  markViewing(a, chat);
  if (a.health?.teams === "login") return failed(a, id, "signed-out");
  const problem = await a.tp.showChat(chat);
  if (problem) return failed(a, id, problem);
  a.store.setState(STATE.activeChat, chat);
  if (!(await saveOpenChat(a, chat))) return failed(a, id, "unreadable");
  return "done";
};

function failed(a: Agent, id: number, reason: OpenReason): Outcome {
  a.store.setState(cmdResultKey(id), JSON.stringify({ reason } satisfies OpenResult));
  return "failed";
}
