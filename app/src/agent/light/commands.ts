import fs from "node:fs";
import path from "node:path";
import { ImageArgs, LIGHT_UNSUPPORTED, MentionArgs, MessageArgs, parseArgs, ReactArgs, TextArgs, type CommandType, type OpenReason, type OpenResult } from "@/shared/slot-db/commands";
import { IMAGE_TYPES, MEDIA_NAME, type ImageExt } from "@/shared/slot-db/rows";
import { cmdResultKey, membersKey, STATE, type Members } from "@/shared/slot-db/state";
import type { Outcome } from "../commands";
import { COMMAND_MAX_AGE } from "../commands";
import { nowSeconds } from "../context";
import { markViewing } from "../jobs/conversation";
import { errorText, log } from "../log";
import type { PendingCommand, SavedMessage } from "../store/slot-store";
import {
  deleteRemoteMessage,
  editTextMessage,
  fetchChatMessages,
  markConversationRead,
  replyTextMessage,
  sendImageMessage,
  sendMentionsMessage,
  sendTextMessage,
  toggleMessageReaction,
} from "../teams/chatsvc";
import type { Light } from "./context";
import { SignedOut } from "./token";

type Handler = (l: Light, cmd: PendingCommand) => Promise<Outcome>;

// The messages of a chat through chatsvc, the pictures and images saved before kept for the same messages
export async function saveChat(l: Light, chat: string): Promise<boolean> {
  const id = l.list.ids.get(chat);
  if (!id) return false;
  const auth = await l.api.auth(l.me);
  const messages = await fetchChatMessages(auth, id, (mids) => l.store.readByCache(mids));
  if (!messages) return false;
  const prev = new Map(l.store.messages(chat).map((m) => [m.mid, m]));
  const kept: SavedMessage[] = messages.map((m) => {
    const before = prev.get(m.mid);
    if (!before || !m.extra) return m;
    const images = m.extra.images?.map((im, i) => (before.images?.[i]?.f ? { ...im, f: before.images[i].f } : im));
    const status = before.status && /seen/i.test(before.status) ? before.status : m.extra.status;
    return { ...m, extra: { ...m.extra, ...(images && { images }), ...(before.av && { av: before.av }), status } };
  });
  l.store.saveChatMessages(chat, kept);
  return true;
}

export async function markRead(l: Light, chat: string) {
  const id = l.list.ids.get(chat);
  l.store.markChatRead(chat);
  if (!id) return;
  try {
    await markConversationRead(await l.api.auth(l.me), id, l.store.messages(chat).at(-1)?.mid);
  } catch (e) {
    log.warn("light", `mark read: ${errorText(e)}`, { chat });
  }
}

// After an action on a message: the chat stays the one in use, its messages saved again, the list read soon
async function after(l: Light, chat: string, ok: boolean, since: number): Promise<Outcome> {
  markViewing(l, chat, since);
  l.store.setState(STATE.activeChat, chat);
  await saveChat(l, chat).catch(() => false);
  l.due.list = Math.min(l.due.list, Date.now() + 1500);
  return ok ? "done" : "failed";
}

function openFailed(l: Light, id: number, reason: OpenReason): Outcome {
  l.store.setState(cmdResultKey(id), JSON.stringify({ reason } satisfies OpenResult));
  return "failed";
}

// conversation of the chat and the token for chatsvc, or null
async function target(l: Light, chat: string) {
  const id = l.list.ids.get(chat);
  return id ? { id, auth: await l.api.auth(l.me) } : null;
}

const open: Handler = async (l, { id, ts, arg1: chat }) => {
  markViewing(l, chat, ts);
  if (l.signedOut) return openFailed(l, id, "signed-out");
  if (!l.list.ids.has(chat)) return openFailed(l, id, "not-listed");
  if (!(await saveChat(l, chat))) return openFailed(l, id, "unreadable");
  l.store.setState(STATE.activeChat, chat);
  void markRead(l, chat);
  return "done";
};

const send: Handler = async (l, { ts, arg1: chat, arg2: text }) => {
  const t = await target(l, chat);
  const ok = !!t && !!text.trim() && (await sendTextMessage(t.auth, t.id, text.trim())).ok;
  return after(l, chat, ok, ts ?? 0);
};

const reply: Handler = async (l, { ts, arg1: chat, arg2 }) => {
  const { mid, text } = parseArgs(TextArgs, arg2);
  const t = await target(l, chat);
  const ok = !!t && !!mid && !!text.trim() && (await replyTextMessage(t.auth, t.id, mid, text.trim())).ok;
  return after(l, chat, ok, ts ?? 0);
};

const edit: Handler = async (l, { ts, arg1: chat, arg2 }) => {
  const { mid, text } = parseArgs(TextArgs, arg2);
  const t = await target(l, chat);
  const ok = !!t && !!mid && !!text.trim() && (await editTextMessage(t.auth, t.id, mid, text.trim()));
  return after(l, chat, ok, ts ?? 0);
};

const remove: Handler = async (l, { ts, arg1: chat, arg2 }) => {
  const { mid } = parseArgs(MessageArgs, arg2);
  const t = await target(l, chat);
  const ok = !!t && !!mid && (await deleteRemoteMessage(t.auth, t.id, mid));
  return after(l, chat, ok, ts ?? 0);
};

const react: Handler = async (l, { ts, arg1: chat, arg2 }) => {
  const { mid, emoji, pill } = parseArgs(ReactArgs, arg2);
  const t = await target(l, chat);
  const ok = !!t && !!mid && (await toggleMessageReaction(t.auth, t.id, mid, pill || emoji || ""));
  return after(l, chat, ok, ts ?? 0);
};

// The upload is deleted whatever happened: the app sends it again on a retry
const sendImage: Handler = async (l, { ts, arg1: chat, arg2 }) => {
  const { file, text } = parseArgs(ImageArgs, arg2);
  if (!MEDIA_NAME.test(file)) return "failed";
  const upload = path.join(l.config.uploadsDir, file);
  try {
    const data = fs.readFileSync(upload);
    const ext = path.extname(file).slice(1) as ImageExt;
    const t = await target(l, chat);
    const ok = !!t && (await sendImageMessage(t.auth, t.id, data, IMAGE_TYPES[ext], text)).ok;
    return await after(l, chat, ok, ts ?? 0);
  } catch (e) {
    log.warn("image", errorText(e), { file });
    return "failed";
  } finally {
    fs.rmSync(upload, { force: true });
  }
};

// The other people of the chat, named
async function peopleOf(l: Light, chat: string): Promise<{ name: string; mri: string }[] | null> {
  const id = l.list.ids.get(chat);
  if (!id) return null;
  const mris = l.list.members.get(id) ?? [];
  const missing = mris.filter((m) => !l.people.has(m));
  if (missing.length) for (const [mri, p] of await l.api.people(missing)) l.people.set(mri, p);
  return mris.flatMap((mri) => {
    const p = l.people.get(mri);
    return p ? [{ name: p.displayName, mri }] : [];
  });
}

const members: Handler = async (l, { ts, arg1: chat }) => {
  markViewing(l, chat, ts);
  l.store.setState(STATE.activeChat, chat);
  const people = await peopleOf(l, chat);
  if (!people) return "failed";
  l.store.setState(membersKey(chat), JSON.stringify({ ts: nowSeconds(), names: people.map((p) => p.name) } satisfies Members));
  return "done";
};

const sendMentions: Handler = async (l, { ts, arg1: chat, arg2 }) => {
  const { parts } = parseArgs(MentionArgs, arg2);
  const t = await target(l, chat);
  const people = await peopleOf(l, chat);
  const ok = !!t && !!people && (await sendMentionsMessage(t.auth, t.id, parts, (name) => people.find((p) => p.name === name)?.mri)).ok;
  return after(l, chat, ok, ts ?? 0);
};

// What the loop does, asked now (src/agent/light/loop.ts)
export type Reads = { list: () => Promise<boolean>; activity: () => Promise<boolean> };

export function lightHandlers(reads: Reads): Partial<Record<CommandType, Handler>> {
  return {
    open,
    send,
    reply,
    edit,
    delete: remove,
    react,
    sendimage: sendImage,
    members,
    sendmentions: sendMentions,
    activity: async () => ((await reads.activity()) ? "done" : "failed"),
    resync: async () => (await reads.list(), "done"),
    // the outcome goes as a push: it also shows that notifications reach the phone
    recheck: async (l) => {
      const ok = (await reads.list()) && (await reads.activity());
      await l.notifier.alert("Teams", ok ? "Everything works" : `Problem: ${l.signedOut ? "signed out, the browser signs in again soon" : l.error || "Teams not reachable"}`);
      return "done";
    },
    check: async () => "done",
  };
}

// Every pending command, oldest first, as the browser agent runs them (src/agent/commands/index.ts)
export async function runLightCommands(l: Light, handlers: Partial<Record<CommandType, Handler>>) {
  const interrupted = l.store.interruptedCommands();
  if (interrupted) log.warn("cmd", "stopped while running, not run again: unconfirmed", { commands: interrupted });
  for (const cmd of l.store.pendingCommands()) {
    const expired = l.store.expirePendingCommands(COMMAND_MAX_AGE);
    if (expired) log.warn("cmd", "waited too long, not run", { commands: expired });
    if (l.store.commandStatus(cmd.id) !== "pending") continue;
    log.info("CMD", cmd.type, { id: cmd.id, arg: cmd.type === "download" ? undefined : cmd.arg1 });
    l.store.startCommand(cmd.id);
    const handler = handlers[cmd.type as CommandType];
    let outcome: Outcome = "failed";
    try {
      outcome = handler ? await handler(l, cmd) : LIGHT_UNSUPPORTED.includes(cmd.type as CommandType) ? "failed" : "done";
    } catch (e) {
      if (e instanceof SignedOut) l.signedOut = true;
      log.warn("cmd", errorText(e), { id: cmd.id, type: cmd.type });
    }
    l.store.finishCommand(cmd.id, outcome);
  }
}
