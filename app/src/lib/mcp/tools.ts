import { PARK_AFTER } from "@/agent/logic/parking";
import type { Message } from "@/shared/slot-db/rows";
import { STATE, Viewing } from "@/shared/slot-db/state";
import { accountSummary, upSince } from "../accounts";
import { appDb, slotsOf, type Slot } from "../appdb";
import { pickSlot } from "../authz";
import { queue } from "../commands";
import { withSlot, type SlotReader } from "../slotdb";

// Read-only tools of /mcp, as functions of the user the token acts as

export class ToolError extends Error {}

type Account = { account?: number };

export type ToolMessage = {
  id: string;
  time?: string;
  author: string;
  mine: boolean;
  text: string;
  quote?: { author: string; text: string };
  reactions?: { emoji: string; count: number; mine: boolean }[];
  images?: number;
  files?: string[];
  edited?: true;
  deleted?: true;
  mentions_me?: true;
};

// An account of the user, ?a=N of the HTTP API: the given slot, or the first one
function accountOf(userId: string, account: number | undefined): Slot {
  const owned = slotsOf(appDb(), userId);
  const slot = pickSlot(
    owned.map((s) => s.slot),
    account === undefined ? null : String(account),
  );
  return owned.find((s) => s.slot === slot)!;
}

// The chat Teams shows, saved by the agent every second: the one last opened, while a chat was in use within
// PARK_AFTER seconds (later Teams parks on the self chat). Nothing while the agent or Teams is not working.
function liveChat(r: SlotReader, s: Slot): string {
  if (s.stopped) return "";
  const h = r.health(upSince(s));
  if (h.agent !== "ok" || h.teams !== "ok") return "";
  const { ts } = Viewing.parse(r.state<unknown>(STATE.viewing, {}) ?? {});
  return Date.now() / 1000 - ts < PARK_AFTER ? r.activeChat() : "";
}

// Teams message ids are the milliseconds of the message
export function messageTime(mid: string): string | undefined {
  return /^\d{13}$/.test(mid) ? new Date(Number(mid)).toISOString() : undefined;
}

function toolMessage(m: Message): ToolMessage {
  const out: ToolMessage = { id: m.mid, time: messageTime(m.mid), author: m.author, mine: !!m.mine, text: m.text };
  if (m.quote) out.quote = m.quote;
  if (m.reactions?.length) out.reactions = m.reactions.map((x) => ({ emoji: x.e, count: x.n, mine: x.mine }));
  if (m.images?.length) out.images = m.images.length;
  if (m.files?.length) out.files = m.files.map((f) => f.name);
  if (m.edited) out.edited = true;
  if (m.deleted) out.deleted = true;
  if (m.mentionsMe) out.mentions_me = true;
  return out;
}

export function chatMessages(r: SlotReader, s: Slot, chat: string) {
  const messages = r.messages(chat).map(toolMessage);
  if (!messages.length && !r.chats().some((c) => c.name === chat)) throw new ToolError("No chat with this name: use a name as list_chats gives it");
  return {
    account: s.slot,
    chat,
    live: liveChat(r, s) === chat,
    messages,
    ...(messages.length ? {} : { note: "No messages saved for this chat yet: refresh_chat opens it in Teams and reads them" }),
  };
}

export function listAccounts(userId: string) {
  return {
    accounts: slotsOf(appDb(), userId).map((s) => {
      const { slot, name, email, tenant, teams, overall, stopped, unread } = accountSummary(s);
      return { slot, name, email, tenant, teams, overall, stopped, unread };
    }),
  };
}

export function listChats(userId: string, { account, unread_only }: Account & { unread_only?: boolean }) {
  const s = accountOf(userId, account);
  return withSlot(s.slot, (r) => {
    const live = liveChat(r, s);
    return {
      account: s.slot,
      chats: r
        .chats()
        .filter((c) => !unread_only || c.unread)
        .map((c) => ({
          name: c.name,
          preview: c.preview,
          last: c.tm,
          unread: !!c.unread,
          ...(c.mention ? { mention: true } : {}),
          ...(c.muted ? { muted: true } : {}),
          ...(c.name === live ? { open: true } : {}),
        })),
    };
  });
}

export function readChat(userId: string, { account, chat }: Account & { chat: string }) {
  const s = accountOf(userId, account);
  return withSlot(s.slot, (r) => chatMessages(r, s, chat));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Opens the chat in Teams with the open command of the app and waits for the agent: Teams marks the chat as read
export async function refreshChat(userId: string, { account, chat }: Account & { chat: string }, wait = { timeoutMs: 30_000, pollMs: 500 }) {
  const s = accountOf(userId, account);
  if (s.stopped) throw new ToolError("This Teams account is stopped: start it in TeamsRelay, from its page or from Settings");
  if (s.check_every) throw new ToolError("This Teams account runs only during its checks: set it to always on in the Settings of TeamsRelay to open chats");
  withSlot(s.slot, (r) => {
    if (!r.chats().some((c) => c.name === chat)) throw new ToolError("No chat with this name: use a name as list_chats gives it");
    const h = r.health(upSince(s));
    if (h.agent !== "ok") throw new ToolError("Teams is not working on this account (agent not running): see list_accounts");
    if (h.teams !== "ok") throw new ToolError(`Teams is not working on this account (${h.teams}): see list_accounts`);
  });
  const id = queue(s.slot, "open", chat);
  const deadline = Date.now() + wait.timeoutMs;
  for (;;) {
    const status = withSlot(s.slot, (r) => r.commandStatus(id))?.status;
    if (status === "done") break;
    if (status === "failed") throw new ToolError("Teams could not open this chat");
    if (Date.now() > deadline) throw new ToolError(`Teams did not open this chat within ${wait.timeoutMs / 1000} s: see list_accounts`);
    await sleep(wait.pollMs);
  }
  return withSlot(s.slot, (r) => {
    // open ends as done even when Teams did not open the chat: only then it becomes the active chat
    if (r.activeChat() !== chat) throw new ToolError("Teams did not open this chat");
    return chatMessages(r, s, chat);
  });
}

export function listActivity(userId: string, { account, unread_only }: Account & { unread_only?: boolean }) {
  const s = accountOf(userId, account);
  return withSlot(s.slot, (r) => {
    const { ts, items } = r.activity();
    return {
      account: s.slot,
      read_at: ts ? new Date(ts * 1000).toISOString() : null,
      items: items
        .filter((i) => !unread_only || i.unread)
        .map((i) => ({
          kind: i.kind,
          actor: i.actor,
          title: i.title,
          ...(i.emoji ? { emoji: i.emoji } : {}),
          preview: i.preview,
          time: i.tm,
          chat: i.chat,
          ...(i.channel ? { channel: true } : {}),
          unread: !!i.unread,
        })),
    };
  });
}
