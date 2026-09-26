import { parseArgs, TextArgs } from "@/shared/slot-db/commands";
import { editMessage } from "../teams/actions";
import { afterMessageAction } from "./finish";
import type { Handler } from "./index";

// arg1: chat, arg2: {mid, text}. Own messages only.
export const edit: Handler = async (a, { arg1: chat, arg2 }) => {
  const { mid, text } = parseArgs(TextArgs, arg2);
  return afterMessageAction(a, chat, await editMessage(a.tp, chat, mid, text));
};
