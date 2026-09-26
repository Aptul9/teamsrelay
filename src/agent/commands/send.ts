import { sendText } from "../teams/actions";
import { afterMessageAction } from "./finish";
import type { Handler } from "./index";

// arg1: chat, arg2: text. Done once Teams shows the message sent; refused when Teams shows another chat or the
// compose box holds a draft.
export const send: Handler = async (a, { arg1: chat, arg2: text }) => afterMessageAction(a, chat, await sendText(a.tp, chat, text));
