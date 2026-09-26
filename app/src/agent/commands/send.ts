import { STATE } from "@/shared/slot-db/state";
import { markViewing, saveOpenChat } from "../jobs/conversation";
import { sendText } from "../teams/actions";
import type { Handler } from "./index";

// arg1: chat, arg2: text. Refused when Teams shows another chat.
export const send: Handler = async (a, { arg1: chat, arg2: text }) => {
  markViewing(a, chat);
  await sendText(a.tp, chat, text);
  a.store.setState(STATE.activeChat, chat);
  await saveOpenChat(a, chat);
  return "done";
};
