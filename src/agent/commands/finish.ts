import { STATE } from "@/shared/slot-db/state";
import type { Agent } from "../context";
import { markViewing, saveOpenChat } from "../jobs/conversation";
import type { Outcome } from "./index";

// After an action on a message: the chat stays the one in use, its new state is saved, then the outcome
export async function afterMessageAction(a: Agent, chat: string, ok: boolean): Promise<Outcome> {
  markViewing(a, chat);
  a.store.setState(STATE.activeChat, chat);
  await saveOpenChat(a, chat);
  return ok ? "done" : "failed";
}
