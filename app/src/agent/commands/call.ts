import type { CallReason, CallResult } from "@/shared/slot-db/commands";
import { cmdResultKey, STATE } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { recordingPage } from "../jobs/calls";
import { markViewing } from "../jobs/conversation";
import { log } from "../log";
import { startAudioCall } from "../teams/call-actions";
import { sleep } from "../teams/page";
import { groupChatShown, readIncomingCall } from "../teams/scripts/calls";
import { openOverlayNames } from "../teams/scripts/message-actions";
import { SEL, TEXTS } from "../teams/selectors";
import type { Handler, Outcome } from "./index";

// Seconds after its tap a call is no longer placed: the app waits a while longer for the outcome, and a call that
// started after the app gave up would ring someone the owner no longer expects
export const CALL_MAX_AGE = 25;
// Milliseconds Teams has to start recording from the microphone once the keys went: a call it placed does at once
export const CALL_START_WAIT = 10_000;
const SELF_CHAT = /\(you\)/i;

// arg1: chat. A Teams audio call to the person of that 1:1 chat, asked from the app: Teams opens the chat and the agent
// presses Teams' own shortcut for an audio call. Done once a Teams page records from the microphone: the call watch
// keeps it in progress from there, named after the person (a.outgoing). Nothing is pressed for a call asked too long
// ago, while a call rings or is in progress (the same keys accept a call ringing as a video call), in a chat the list
// does not show as 1:1 or whose header shows its participants, or in the self chat; failed then, with the reason in
// cmd_result:<id>.
export const call: Handler = async (a, { id, arg1: chat, ts }) => {
  if (ts && nowSeconds() - ts >= CALL_MAX_AGE) return failed(a, id, chat, "late");
  if (a.ringing || a.inCall) return failed(a, id, chat, "busy");
  if (a.health?.teams === "login") return failed(a, id, chat, "signed-out");
  if (SELF_CHAT.test(chat) || a.store.chats().find((c) => c.name === chat)?.kind !== "one") return failed(a, id, chat, "not-one");
  markViewing(a, chat, ts);
  const problem = await a.tp.showChat(chat);
  if (problem) return failed(a, id, chat, problem);
  a.store.setState(STATE.activeChat, chat);
  const page = a.tp.page;
  if (await page.evaluate(groupChatShown, SEL)) return failed(a, id, chat, "not-one");
  a.outgoing = { callee: chat, since: Date.now() };
  const pressed = await startAudioCall(page, async () => !a.ringing && !a.inCall && !(await page.evaluate(readIncomingCall, { s: SEL, t: TEXTS })));
  if (!pressed) {
    a.outgoing = undefined;
    return failed(a, id, chat, "busy");
  }
  log.info("call", "calling", { callee: chat });
  for (const until = Date.now() + CALL_START_WAIT; Date.now() < until; await sleep(250)) {
    if (await recordingPage(page)) {
      log.info("call", "placed", { callee: chat });
      return "done";
    }
  }
  a.outgoing = undefined;
  const overlays = await page.evaluate(openOverlayNames, SEL).catch(() => []);
  log.warn("call", "Teams did not start the call", { callee: chat, overlays: overlays.join(", ") || undefined });
  return failed(a, id, chat, "no-call");
};

function failed(a: Agent, id: number, chat: string, reason: CallReason): Outcome {
  log.info("call", "not placed", { callee: chat, reason });
  a.store.setState(cmdResultKey(id), JSON.stringify({ reason } satisfies CallResult));
  return "failed";
}
