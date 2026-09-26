import { MentionArgs, parseArgs } from "@/shared/slot-db/commands";
import { sendWithMentions } from "../teams/mentions";
import { afterMessageAction } from "./finish";
import type { Handler } from "./index";

// arg1: chat, arg2: {parts}. Text and people tagged with @, each picked in the Teams list.
export const sendMentions: Handler = async (a, { arg1: chat, arg2 }) => {
  const { parts } = parseArgs(MentionArgs, arg2);
  if (!parts.length) return "failed";
  return afterMessageAction(a, chat, await sendWithMentions(a.tp, chat, parts));
};
