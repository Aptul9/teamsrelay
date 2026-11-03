import type { Presence } from "@/shared/presence";
import { CHAT_LIMIT, type ChatEntry } from "../logic/chats";
import { parseTeamsMessageHtml } from "../teams/chatsvc";
import type { CsaChat, Person, PersonPresence } from "./api";

// The chat list of a light account, made from the aggregator as the browser agent reads it from the page: the same
// names (title, the other person of a 1:1 chat, the first names of a group without a title), previews ("You: " for your
// own), times ("9:05 AM" today, "11/2" before), so a chat keeps its messages and its place when an account changes mode.

// "9:05 AM" on the day of `now`, "11/2" before, in the time zone of the process (TZ)
export function listTime(at: Date, now: Date): string {
  if (Number.isNaN(at.getTime())) return "";
  if (at.toDateString() === now.toDateString()) {
    const h = at.getHours();
    return `${h % 12 || 12}:${String(at.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }
  return `${at.getMonth() + 1}/${at.getDate()}`;
}

// A presence of the API as one of the words of the app (shared/presence)
export function presenceWord(p: PersonPresence | undefined): Presence | "" {
  if (!p) return "";
  if (/outofoffice/i.test(p.activity)) return "ooo";
  switch (p.availability) {
    case "Available":
    case "AvailableIdle":
      return "available";
    case "Busy":
    case "BusyIdle":
      return /presenting|focusing/i.test(p.activity) ? "dnd" : "busy";
    case "DoNotDisturb":
      return "dnd";
    case "Away":
    case "BeRightBack":
      return "away";
    case "Offline":
      return "offline";
    default:
      return "";
  }
}

const arrival = (c: CsaChat) => Date.parse(c.lastMessage?.originalArrivalTime || c.lastMessage?.composeTime || c.createdAt || "") || 0;

// The chats the list shows: with a message, not deleted, the newest first, as many as the page list keeps
export function listedChats(chats: readonly CsaChat[], limit = CHAT_LIMIT): CsaChat[] {
  return chats.filter((c) => !c.isConversationDeleted && c.lastMessage?.id).sort((x, y) => arrival(y) - arrival(x)).slice(0, limit);
}

// The other people of a chat (mri), you left out
export const othersOf = (c: CsaChat, me: string) => (c.members ?? []).map((m) => m.mri).filter((mri) => mri && !mri.toLowerCase().includes(me.toLowerCase()));

// People whose name a chat needs and nobody gave yet: the other person of a 1:1 chat, the members of a group chat
// without a title
export function unnamedPeople(chats: readonly CsaChat[], me: string, names: ReadonlyMap<string, Person>): string[] {
  const out = new Set<string>();
  for (const c of chats) {
    if (c.title?.trim()) continue;
    for (const mri of othersOf(c, me).slice(0, c.isOneOnOne ? 1 : 4)) if (!names.has(mri)) out.add(mri);
  }
  return [...out];
}

// The chats a name of a person is still missing for, once the look-ups answered
export const unnamedChats = (chats: readonly CsaChat[], me: string, names: ReadonlyMap<string, Person>) => chats.filter((c) => !chatName(c, me, names));

// How the list names a chat; "" while a name it needs is unknown
export function chatName(c: CsaChat, me: string, names: ReadonlyMap<string, Person>): string {
  const title = c.title?.trim();
  if (title) return title;
  const others = othersOf(c, me);
  if (c.isOneOnOne) {
    const other = others[0] ? names.get(others[0]) : undefined;
    if (other) return other.displayName;
    return !c.isLastMessageFromMe ? (c.lastMessage?.imDisplayName ?? "").trim() : "";
  }
  const shown = others.slice(0, 4).map((mri) => names.get(mri)?.givenName);
  if (!shown.length || shown.some((n) => !n)) return "";
  const more = others.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? `, +${more}` : ""}`;
}

export const chatKind = (c: CsaChat) => (c.isOneOnOne ? "one" : c.chatType === "meeting" ? "meeting" : "group");

// The text of the last message as the list previews it: first line, "You: " for your own
export function previewOf(c: CsaChat): string {
  const text = parseTeamsMessageHtml(c.lastMessage?.content ?? "").text.split("\n")[0]?.trim() ?? "";
  if (!text) return "";
  return (c.isLastMessageFromMe ? `You: ${text}` : text).slice(0, 200);
}

export type LightList = {
  rows: ChatEntry[];
  // chat name to conversation id, for the commands and the reads of messages
  ids: Map<string, string>;
};

type ListInput = {
  me: string;
  names: ReadonlyMap<string, Person>;
  presence: ReadonlyMap<string, PersonPresence>;
  // conversations with a mention of you not read yet
  mentioned: ReadonlySet<string>;
  now: Date;
  // the chat with yourself, which the aggregator does not list: its name and last message
  notes?: { name: string; content: string; time: string } | null;
};

export function lightList(chats: readonly CsaChat[], o: ListInput): LightList {
  const ids = new Map<string, string>();
  const rows: ChatEntry[] = [];
  const entries: { at: number; row: ChatEntry }[] = [];
  for (const c of listedChats(chats, o.notes ? CHAT_LIMIT - 1 : CHAT_LIMIT)) {
    const name = chatName(c, o.me, o.names);
    // a name another chat of the list already took: the first (newest) keeps it, as a tap in the page list would
    if (!name || ids.has(name)) continue;
    ids.set(name, c.id);
    const other = c.isOneOnOne ? othersOf(c, o.me)[0] : undefined;
    entries.push({
      at: arrival(c),
      row: {
        name,
        preview: previewOf(c),
        time: listTime(new Date(arrival(c)), o.now),
        unread: c.isRead === false && !c.isLastMessageFromMe,
        mention: o.mentioned.has(c.id),
        muted: c.isMuted === true,
        av: "",
        presence: other ? presenceWord(o.presence.get(other)) : "",
        kind: chatKind(c),
      },
    });
  }
  if (o.notes) {
    const at = Date.parse(o.notes.time) || 0;
    ids.set(o.notes.name, "48:notes");
    const text = parseTeamsMessageHtml(o.notes.content).text.split("\n")[0]?.trim() ?? "";
    entries.push({ at, row: { name: o.notes.name, preview: text ? `You: ${text}`.slice(0, 200) : "", time: listTime(new Date(at), o.now), unread: false, mention: false, muted: false, av: "", presence: "", kind: "one" } });
  }
  entries.sort((x, y) => y.at - x.at);
  for (const e of entries) rows.push(e.row);
  return { rows, ids };
}
