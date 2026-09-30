import { MessageArgs, parseArgs } from "@/shared/slot-db/commands";
import { undoDelete as undoOnTeams } from "../teams/actions";
import { afterMessageAction } from "./finish";
import type { Handler } from "./index";

// arg1: chat, arg2: {mid}
export const undoDelete: Handler = async (a, { ts, arg1: chat, arg2 }) => {
  const { mid } = parseArgs(MessageArgs, arg2);
  return afterMessageAction(a, chat, await undoOnTeams(a.tp, chat, mid), ts);
};
