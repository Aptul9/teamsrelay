import { parseArgs, ReactArgs } from "@/shared/slot-db/commands";
import { react as reactOnTeams, togglePill } from "../teams/actions";
import { afterMessageAction } from "./finish";
import type { Handler } from "./index";

// arg1: chat, arg2: {mid, emoji} for a reaction of the bar or the picker, {mid, pill} for a click on a pill
export const react: Handler = async (a, { arg1: chat, arg2 }) => {
  const { mid, emoji, pill } = parseArgs(ReactArgs, arg2);
  const ok = pill ? await togglePill(a.tp, chat, mid, pill) : await reactOnTeams(a.tp, chat, mid, emoji ?? "");
  return afterMessageAction(a, chat, ok);
};
