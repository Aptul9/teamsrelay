import { saveOpenChat } from "../jobs/conversation";
import { sendText } from "../teams/actions";
import { afterMessageAction } from "./finish";
import type { Handler } from "./index";

// arg1: chat, arg2: text. Done once Teams shows the message sent; refused when Teams shows another chat or the
// compose box holds a draft. The chat is saved as soon as the message went, and again at the end.
export const send: Handler = async (a, { ts, arg1: chat, arg2: text }) =>
  afterMessageAction(a, chat, await sendText(a.tp, chat, text, () => saveOpenChat(a, chat)), ts);
