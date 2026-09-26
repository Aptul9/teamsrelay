import { oneToOneKey } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { readByTodo, READBY_RECENT } from "../logic/read-by";
import { readReceipts } from "../teams/actions";
import { saveOpenChat } from "./conversation";

// Refreshes "Read by" of one of your recent messages in the open chat, one message per call. True when it
// worked on Teams.
export async function prefetchReadBy(a: Agent, chat: string): Promise<boolean> {
  if (!chat || a.store.getState(oneToOneKey(chat)) === "1") return false;
  const todo = readByTodo(a.store.ownRecentMessageIds(chat, READBY_RECENT), a.store.readByOf(chat), nowSeconds());
  if (!todo.length) return false;
  const mid = todo[0];
  const res = await readReceipts(a.tp, chat, mid);
  if (!res) return true;
  // 1:1 chat: the Seen status is enough
  if (!res.label) {
    a.store.setState(oneToOneKey(chat), "1");
    return true;
  }
  a.store.saveReadBy(mid, chat, res);
  await saveOpenChat(a, chat);
  return true;
}
