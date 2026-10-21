import { z } from "zod";
import { parseState, STATE } from "@/shared/slot-db/state";
import type { Agent } from "../context";
import { union } from "../logic/check-seen";
import { errorText, log } from "../log";
import { inApp } from "./page-setup";

const Ids = z.array(z.string()).catch([]);

// A mention of you that the chat list does not notify: in a muted chat (Teams mutes its messages, not the @mentions of
// you) or in a channel, which the list does not show. A mention in any other chat is a new message of the list already
// (jobs/chat-list.ts).
const quiet = (a: Pick<Agent, "store">, m: { chat: string; channel: boolean }) => m.channel || a.store.isMutedChat(m.chat);

// Each such mention still unread in the feed notifies once, as Teams does: who, where, and the text. The first feed
// an account reads only records what it has: an agent that starts pushes none of the past. Recorded before the
// pushes: one that fails is not pushed again. None for the chat the app shows now. Number of mentions pushed.
export async function pushMentions(a: Agent): Promise<number> {
  const mentions = a.store.mentions();
  const raw = a.store.getState(STATE.mentionsTold);
  const told = raw ? parseState(Ids, raw, []) : null;
  const known = new Set(told ?? []);
  const fresh = told ? mentions.filter((m) => !known.has(m.id) && m.unread && quiet(a, m) && !inApp(a, m.chat)) : [];
  a.store.setState(STATE.mentionsTold, JSON.stringify(union(mentions.map((m) => m.id), told ?? undefined)));
  for (const m of fresh) {
    const chat = a.store.isKnownChat(m.chat) ? m.chat : "";
    log.info("MENTION", m.chat, { by: m.actor, preview: m.preview.slice(0, 50) });
    try {
      await a.notifier.message(m.chat || m.actor, `${m.actor ? `${m.actor} mentioned you` : "You were mentioned"}${m.preview ? `: ${m.preview}` : ""}`, chat);
    } catch (e) {
      log.warn("mentions", `push: ${errorText(e)}`);
    }
  }
  return fresh.length;
}
