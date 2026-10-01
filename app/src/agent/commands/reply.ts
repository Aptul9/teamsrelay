import { parseArgs, TextArgs } from "@/shared/slot-db/commands";
import { saveOpenChat } from "../jobs/conversation";
import { replyWithQuote } from "../teams/actions";
import { afterMessageAction } from "./finish";
import type { Handler } from "./index";

// arg1: chat, arg2: {mid, text}. Reply with quote; the chat is saved as soon as the reply went, and again at the end.
export const reply: Handler = async (a, { ts, arg1: chat, arg2 }) => {
  const { mid, text } = parseArgs(TextArgs, arg2);
  return afterMessageAction(a, chat, await replyWithQuote(a.tp, chat, mid, text, () => saveOpenChat(a, chat)), ts);
};
