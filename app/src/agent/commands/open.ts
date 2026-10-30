import type { OpenReason, OpenResult } from "@/shared/slot-db/commands";
import { cmdResultKey, STATE } from "@/shared/slot-db/state";
import type { Agent } from "../context";
import { markReadViaApi, markViewing, saveChatViaApi, saveOpenChat, servedByApi } from "../jobs/conversation";
import type { Handler, Outcome } from "./index";

// arg1: chat. The app shows the chat: Teams opens it and the agent saves its messages. Done once they are saved, so
// the app can tell the messages of this visit from the ones saved at the last one; failed otherwise, with the reason in
// cmd_result:<id>. While Teams is signed out nothing is touched: there is no chat list to click in (while it loads, the
// open waits in the queue: runPendingCommands).
export const open: Handler = async (a, { id, ts, arg1: chat }) => {
  markViewing(a, chat, ts);
  if (a.health?.teams === "login") return failed(a, id, "signed-out");
  // Instant fast-path when chatsvc keeps this chat fresh and its messages are cached: done at 0 ms, refresh in background
  if (servedByApi(chat) && a.store.messages(chat).length > 0) {
    a.store.setState(STATE.activeChat, chat);
    void markReadViaApi(a, chat);
    void saveChatViaApi(a, chat).catch(() => undefined);
    return "done";
  }
  // Fast path: fetch messages directly via chatsvc API (~150 ms) without touching the DOM
  if (await saveChatViaApi(a, chat)) {
    a.store.setState(STATE.activeChat, chat);
    void markReadViaApi(a, chat);
    return "done";
  }
  const problem = await a.tp.showChat(chat);
  if (problem) return failed(a, id, problem);
  a.store.setState(STATE.activeChat, chat);
  if (!(await saveOpenChat(a, chat))) return failed(a, id, "unreadable");
  return "done";
};

function failed(a: Agent, id: number, reason: OpenReason): Outcome {
  a.store.setState(cmdResultKey(id), JSON.stringify({ reason } satisfies OpenResult));
  return "failed";
}
