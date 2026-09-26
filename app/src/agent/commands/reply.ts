import { parseArgs, TextArgs } from "@/shared/slot-db/commands";
import { replyWithQuote } from "../teams/actions";
import { afterMessageAction } from "./finish";
import type { Handler } from "./index";

// arg1: chat, arg2: {mid, text}. Reply with quote.
export const reply: Handler = async (a, { arg1: chat, arg2 }) => {
  const { mid, text } = parseArgs(TextArgs, arg2);
  return afterMessageAction(a, chat, await replyWithQuote(a.tp, chat, mid, text));
};
