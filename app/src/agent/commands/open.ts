import { STATE } from "@/shared/slot-db/state";
import { markViewing, saveOpenChat } from "../jobs/conversation";
import type { Handler } from "./index";

// arg1: chat. The app shows the chat: Teams opens it and the agent saves its messages.
export const open: Handler = async (a, { arg1: chat }) => {
  markViewing(a, chat);
  if (await a.tp.openChat(chat)) {
    a.store.setState(STATE.activeChat, chat);
    await saveOpenChat(a, chat);
  }
  return "done";
};
