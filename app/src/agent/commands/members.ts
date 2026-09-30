import { STATE, membersKey, type Members } from "@/shared/slot-db/state";
import { nowSeconds } from "../context";
import { markViewing } from "../jobs/conversation";
import { readMembers } from "../teams/mentions";
import type { Handler } from "./index";

// arg1: chat. The people of the chat, for the @ of the app, go to the state row members:<chat> with the time.
export const members: Handler = async (a, { ts, arg1: chat }) => {
  markViewing(a, chat, ts);
  const names = await readMembers(a.tp, chat);
  a.store.setState(STATE.activeChat, chat);
  if (!names) return "failed";
  a.store.setState(membersKey(chat), JSON.stringify({ ts: nowSeconds(), names } satisfies Members));
  return "done";
};
