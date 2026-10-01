import { STATE } from "@/shared/slot-db/state";
import type { Agent } from "../context";
import { markViewing, saveOpenChat } from "../jobs/conversation";
import type { SendResult } from "../teams/page";
import type { Outcome } from "./index";

// After an action on a message: the chat stays the one in use, its new state is saved, then the outcome. A message
// that went out without Teams showing it sent is unconfirmed: the app must not invite to send it again. since: when
// the command was queued (markViewing).
export async function afterMessageAction(a: Agent, chat: string, result: boolean | SendResult, since = 0): Promise<Outcome> {
  markViewing(a, chat, since);
  a.store.setState(STATE.activeChat, chat);
  await saveOpenChat(a, chat);
  if (result === "unconfirmed") return "unconfirmed";
  return result === true || result === "sent" ? "done" : "failed";
}
