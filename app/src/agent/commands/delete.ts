import { MessageArgs, parseArgs } from "@/shared/slot-db/commands";
import { deleteMessage } from "../teams/actions";
import { afterMessageAction } from "./finish";
import type { Handler } from "./index";

// arg1: chat, arg2: {mid}. Own messages only; Teams leaves Undo for a few seconds.
export const deleteCommand: Handler = async (a, { arg1: chat, arg2 }) => {
  const { mid } = parseArgs(MessageArgs, arg2);
  return afterMessageAction(a, chat, await deleteMessage(a.tp, chat, mid));
};
