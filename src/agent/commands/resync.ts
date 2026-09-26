import { STATE } from "@/shared/slot-db/state";
import { readList, withoutPictures } from "../jobs/chat-list";
import { saveOpenChat } from "../jobs/conversation";
import type { Handler } from "./index";

// Reads the chat list and the open conversation again
export const resync: Handler = async (a) => {
  try {
    a.store.saveChats(withoutPictures(await readList(a)));
  } catch {
    // the open conversation is still read
  }
  const active = a.store.getState(STATE.activeChat);
  if (active) await saveOpenChat(a, active);
  return "done";
};
