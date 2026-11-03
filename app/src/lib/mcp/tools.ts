import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isSharePointUrl } from "@/agent/logic/files";
import { shownInApp } from "@/agent/logic/parking";
import { commandOf, mentionNames, messageText } from "@/shared/command-input";
import { DownloadResult, type CommandType, type DownloadArgs } from "@/shared/slot-db/commands";
import { FILE_NAME, IMAGE_TYPES, MEDIA_NAME, type ImageExt, type Message } from "@/shared/slot-db/rows";
import { STATE, Viewing } from "@/shared/slot-db/state";
import { accountSummary, upSince } from "../accounts";
import { appDb, slotsOf, type Slot } from "../appdb";
import { pickSlot } from "../authz";
import { idleReason, queue } from "../commands";
import { config } from "../config";
import { mentionParts } from "../mentions";
import { sentAt } from "../message-times";
import { slotDir, withSlot, type SlotReader } from "../slotdb";
import { uploadsDir, saveImage } from "../uploads";

// Tools of /mcp, as functions of the user the token acts as: reads of what the agent saved, and commands the agent
// runs on Teams (the same ones the app queues)

export class ToolError extends Error {}

type Account = { account?: number };

type ToolMessage = {
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

// The chat Teams shows, saved by the agent every second: the one last opened, while the app shows a chat (marked
// within PARK_AFTER seconds, not left since; otherwise Teams parks on the self chat). Nothing while the agent or Teams
// is not working.
function liveChat(r: SlotReader, s: Slot): string {
  if (s.stopped) return "";
  const h = r.health(upSince(s));
  if (h.agent !== "ok" || h.teams !== "ok") return "";
  return shownInApp(Viewing.parse(r.state<unknown>(STATE.viewing, {}) ?? {}), Date.now() / 1000) ? r.activeChat() : "";
}

// Teams message ids are the milliseconds of the message
export function messageTime(mid: string): string | undefined {
  const at = sentAt(mid);
  return at === null ? undefined : new Date(at).toISOString();
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

function chatMessages(r: SlotReader, s: Slot, chat: string) {
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
          ...(c.presence ? { presence: c.presence } : {}),
          ...(c.name === live ? { open: true } : {}),
        })),
    };
  });
}

export function readChat(userId: string, { account, chat }: Account & { chat: string }) {
  const s = accountOf(userId, account);
  return withSlot(s.slot, (r) => chatMessages(r, s, chat));
}

// The account takes commands, Teams works on it and the chat is in its list: nothing is queued otherwise
function canAct(s: Slot, chat: string) {
  const idle = idleReason(s.slot);
  if (idle) throw new ToolError(idle);
  withSlot(s.slot, (r) => {
    if (!r.chats().some((c) => c.name === chat)) throw new ToolError("No chat with this name: use a name as list_chats gives it");
    const h = r.health(upSince(s));
    if (h.agent !== "ok") throw new ToolError("Teams is not working on this account (agent not running): see list_accounts");
    if (h.teams !== "ok") throw new ToolError(`Teams is not working on this account (${h.teams}): see list_accounts`);
  });
}


// Opens the chat in Teams with the open command of the app and waits for the agent: Teams marks the chat as read
export async function refreshChat(userId: string, { account, chat }: Account & { chat: string }, wait = { timeoutMs: 30_000, pollMs: 500 }) {
  const s = accountOf(userId, account);
  canAct(s, chat);
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
    // an agent of an earlier release ends open as done even when Teams did not open the chat: only then it becomes the
    // active chat
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

// ---- commands: what the app does on a message, run by the agent of the account on Teams

export type Wait = { timeoutMs: number; pollMs: number };
// The agent drops a command older than 2 minutes (COMMAND_MAX_AGE): a tool waits less, then says it is still queued
const COMMAND_WAIT: Wait = { timeoutMs: 45_000, pollMs: 300 };

type Ran = { id: number; status: "done" | "failed" | "pending"; result: unknown };

async function run(slot: number, type: CommandType, arg1: string, arg2: string, wait: Wait): Promise<Ran> {
  const id = queue(slot, type, arg1, arg2);
  const deadline = Date.now() + wait.timeoutMs;
  for (;;) {
    const st = withSlot(slot, (r) => r.commandStatus(id));
    if (st && st.status !== "pending") return { id, status: st.status === "done" ? "done" : "failed", result: st.result };
    if (Date.now() > deadline) return { id, status: "pending", result: null };
    await sleep(wait.pollMs);
  }
}

// What a tool answers once its command ran: the message as the agent saved it right after (null when not among the
// saved ones). A failed command may still have reached Teams (the agent stopped while it ran, Teams did not show it).
function outcome(s: Slot, chat: string, ran: Ran, what: string, mid: string | null) {
  if (ran.status === "failed") {
    throw new ToolError(`Teams did not confirm ${what}: read_chat (or refresh_chat) shows whether it happened, check before trying again`);
  }
  const base = { account: s.slot, chat, command: ran.id, status: ran.status };
  if (ran.status === "pending") {
    return { ...base, note: `Queued, not run yet: the agent runs it within 2 minutes or drops it. read_chat shows the outcome later` };
  }
  const message = withSlot(s.slot, (r) => {
    const all = r.messages(chat);
    const m = mid === null ? all.filter((x) => x.mine && !x.deleted).at(-1) : all.find((x) => x.mid === mid);
    return m ? toolMessage(m) : null;
  });
  return { ...base, message };
}

const REACTION_NAMES = new Set(["like", "heart", "laugh", "surprised", "cry", "angry"]);

// base64 of an image, a data: URL included
function imageBytes(v: string): Buffer {
  const data = Buffer.from(v.replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, ""), "base64");
  if (!data.length) throw new ToolError("image is not base64");
  return data;
}

type SendArgs = Account & { chat: string; text?: string; reply_to?: string; mentions?: string[]; image?: string };

// A message, a reply with quote, a message tagging people (@name in the text, name in mentions) or an image with an
// optional caption
export async function sendMessage(userId: string, a: SendArgs, wait: Wait = COMMAND_WAIT) {
  const s = accountOf(userId, a.account);
  const text = a.text ?? "";
  if (a.image && (a.reply_to || a.mentions?.length)) throw new ToolError("An image goes alone or with a caption in text: no reply_to or mentions with it");
  if (!a.image && !text.trim()) throw new ToolError("text is required (or image)");
  canAct(s, a.chat);
  if (a.image) {
    const file = saveImage(s.slot, imageBytes(a.image));
    let ran: Ran;
    try {
      ran = await run(s.slot, "sendimage", a.chat, JSON.stringify({ file, text }), wait);
    } catch (e) {
      fs.rmSync(path.join(uploadsDir(s.slot), file), { force: true });
      throw e;
    }
    return outcome(s, a.chat, ran, "the image was sent", null);
  }
  if (a.reply_to) {
    if (a.mentions?.length) throw new ToolError("A reply cannot tag people: send a message with mentions instead");
    const c = commandOf({ type: "reply", chat: a.chat, mid: a.reply_to, text });
    return outcome(s, a.chat, await run(s.slot, c.type, c.arg1, c.arg2, wait), "the reply was sent", null);
  }
  const parts = mentionParts(messageText(text), mentionNames(a.mentions));
  const ran = parts.some((p) => "mention" in p)
    ? await run(s.slot, "sendmentions", a.chat, JSON.stringify({ parts }), wait)
    : await run(s.slot, "send", a.chat, text, wait);
  return outcome(s, a.chat, ran, "the message was sent", null);
}

type MessageRef = Account & { chat: string; message_id: string };

// One of the six quick reactions by name, or the emoji of a reaction already under the message (as read_chat gives
// it). Like in Teams, a reaction that is already yours is taken away.
export async function reactMessage(userId: string, a: MessageRef & { reaction: string }, wait: Wait = COMMAND_WAIT) {
  const s = accountOf(userId, a.account);
  canAct(s, a.chat);
  const name = a.reaction.trim().toLowerCase();
  const c = commandOf({ type: "react", chat: a.chat, mid: a.message_id, ...(REACTION_NAMES.has(name) ? { emoji: name } : { pill: a.reaction }) });
  return outcome(s, a.chat, await run(s.slot, c.type, c.arg1, c.arg2, wait), "the reaction", a.message_id);
}

export async function editMessage(userId: string, a: MessageRef & { text: string }, wait: Wait = COMMAND_WAIT) {
  const s = accountOf(userId, a.account);
  canAct(s, a.chat);
  const c = commandOf({ type: "edit", chat: a.chat, mid: a.message_id, text: a.text });
  return outcome(s, a.chat, await run(s.slot, c.type, c.arg1, c.arg2, wait), "the edit", a.message_id);
}

export async function deleteMessage(userId: string, a: MessageRef, wait: Wait = COMMAND_WAIT) {
  const s = accountOf(userId, a.account);
  canAct(s, a.chat);
  const c = commandOf({ type: "delete", chat: a.chat, mid: a.message_id });
  return outcome(s, a.chat, await run(s.slot, c.type, c.arg1, c.arg2, wait), "the delete", a.message_id);
}

export async function undoDelete(userId: string, a: MessageRef, wait: Wait = COMMAND_WAIT) {
  const s = accountOf(userId, a.account);
  canAct(s, a.chat);
  const c = commandOf({ type: "undodelete", chat: a.chat, mid: a.message_id });
  return outcome(s, a.chat, await run(s.slot, c.type, c.arg1, c.arg2, wait), "the message was brought back", a.message_id);
}

// ---- attachments: images the agent saved, SharePoint files it downloads with the Teams session

// Largest file a tool answer carries
export const MAX_INLINE = 8e6;
// Longest text of a text file a tool answer carries
const MAX_TEXT = 200_000;

const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const TEXT_EXT = /^(txt|md|csv|tsv|json|xml|html?|log|ya?ml|ini|conf|cfg|toml|sql|sh|ps1|bat|py|js|ts|java|cs|go|rb|php|css|tf|hcl)$/;

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

type Attachment = { index: number; kind: "image" | "file"; name?: string; shown: boolean; note?: string; link?: string };

// An image of a message the page could not fetch, by its public link (Giphy...): HTTPS to a named host only, never
// an address of the server's own network
async function publicImage(url: string): Promise<{ data: Buffer; type: string } | string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a link";
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (u.protocol !== "https:" || net.isIP(host) || !host.includes(".") || /(^|\.)(localhost|local|internal|lan)$/i.test(host)) return "not a public link";
  if (/(^|\.)(asm\.skype\.com|teams\.microsoft\.com|teams\.cloud\.microsoft)$/i.test(host)) {
    return "Teams keeps this image behind the sign-in of the account and it is not saved yet: refresh_chat saves it";
  }
  try {
    const r = await fetch(u, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    const type = (r.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!r.ok || !type.startsWith("image/")) return `the link answered ${r.status} ${type || "without a type"}`;
    if (Number(r.headers.get("content-length") ?? 0) > MAX_INLINE) return "larger than 8 MB";
    const data = Buffer.from(await r.arrayBuffer());
    return data.length > MAX_INLINE ? "larger than 8 MB" : { data, type };
  } catch (e) {
    return `not fetched: ${(e as Error).message}`;
  }
}

// The file of a finished download: a relay uploads it to the server right after, so it may come a little later
async function downloaded(slot: number, f: string, wait: Wait): Promise<Buffer | null> {
  const file = path.join(slotDir(slot), "files", f);
  const deadline = Date.now() + Math.min(wait.timeoutMs, 20_000);
  for (;;) {
    if (fs.existsSync(file)) return fs.readFileSync(file);
    if (Date.now() > deadline) return null;
    await sleep(wait.pollMs);
  }
}

// The images (first, in order) and files of a saved message, as content of the answer: images to look at, text files
// as text, other files as embedded resources. index: 1-based, the images first, then the files; all when missing.
export async function getAttachment(userId: string, a: MessageRef & { index?: number }, wait: Wait = COMMAND_WAIT): Promise<Content[]> {
  const s = accountOf(userId, a.account);
  const m = withSlot(s.slot, (r) => r.messages(a.chat).find((x) => x.mid === a.message_id));
  if (!m) throw new ToolError("No saved message with this id in this chat: read_chat gives the ids (refresh_chat for current ones)");
  const all = [
    ...(m.images ?? []).map((im) => ({ kind: "image" as const, f: im.f, url: im.url })),
    ...(m.files ?? []).map((f) => ({ kind: "file" as const, name: f.name, url: f.url })),
  ];
  if (!all.length) throw new ToolError("This message has no image or file");
  if (a.index !== undefined && (a.index < 1 || a.index > all.length)) throw new ToolError(`index out of range: the message has ${all.length} attachment(s)`);
  const picked = a.index === undefined ? all.map((x, i) => ({ ...x, index: i + 1 })) : [{ ...all[a.index - 1], index: a.index }];

  const blocks: Content[] = [];
  const list: Attachment[] = [];
  for (const x of picked) {
    if (x.kind === "image") {
      const at: Attachment = { index: x.index, kind: "image", shown: false };
      list.push(at);
      if (x.f && MEDIA_NAME.test(x.f)) {
        const file = path.join(slotDir(s.slot), "media", x.f);
        if (fs.existsSync(file)) {
          blocks.push({ type: "image", data: fs.readFileSync(file).toString("base64"), mimeType: IMAGE_TYPES[path.extname(x.f).slice(1) as ImageExt] });
          at.shown = true;
          continue;
        }
      }
      if (!x.url) {
        at.note = "the image is not saved on the server (yet): refresh_chat saves the images of the chat";
        continue;
      }
      const got = await publicImage(x.url);
      if (typeof got === "string") {
        at.note = got;
        at.link = x.url;
      } else {
        blocks.push({ type: "image", data: got.data.toString("base64"), mimeType: got.type });
        at.shown = true;
      }
      continue;
    }
    const at: Attachment = { index: x.index, kind: "file", name: x.name, shown: false };
    list.push(at);
    if (!isSharePointUrl(x.url)) {
      at.note = "not on SharePoint or OneDrive: not downloaded";
      at.link = x.url;
      continue;
    }
    let ran: Ran;
    try {
      ran = await run(s.slot, "download", x.url, JSON.stringify({ name: x.name } satisfies DownloadArgs), wait);
    } catch (e) {
      at.note = (e as Error).message;
      at.link = x.url;
      continue;
    }
    const res = DownloadResult.safeParse(ran.result);
    if (ran.status !== "done" || !res.success || !FILE_NAME.test(res.data.f)) {
      at.note = ran.status === "pending" ? "download still queued: ask again in a minute" : "Teams did not give the file";
      at.link = x.url;
      continue;
    }
    const data = await downloaded(s.slot, res.data.f, wait);
    const link = `${config.appUrl}/files/${res.data.f}?a=${s.slot}&name=${encodeURIComponent(x.name)}`;
    at.link = link;
    if (!data) {
      at.note = "downloaded, not on the server yet: ask again in a minute";
      continue;
    }
    if (data.length > MAX_INLINE) {
      at.note = `${Math.round(data.length / 1e6)} MB, too large to carry here: open the link signed in to the app`;
      continue;
    }
    const ext = path.extname(x.name).slice(1).toLowerCase();
    const type = FILE_TYPES[ext] ?? (TEXT_EXT.test(ext) ? "text/plain" : "application/octet-stream");
    if (type.startsWith("image/")) {
      blocks.push({ type: "image", data: data.toString("base64"), mimeType: type });
    } else if (type === "text/plain") {
      const text = data.toString("utf8");
      blocks.push({ type: "text", text: `--- ${x.name} ---\n${text.slice(0, MAX_TEXT)}${text.length > MAX_TEXT ? "\n[cut]" : ""}` });
    } else {
      blocks.push({ type: "resource", resource: { uri: link, mimeType: type, blob: data.toString("base64") } });
    }
    at.shown = true;
  }
  const summary = { account: s.slot, chat: a.chat, message: toolMessage(m), attachments: list };
  return [{ type: "text", text: JSON.stringify(summary) }, ...blocks];
}
