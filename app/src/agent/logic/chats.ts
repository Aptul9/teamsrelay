import { TEXTS } from "../teams/selectors";

// A chat of the Teams list, as the agent keeps it (tm in the chats table is time here)
// presence: a word of shared/presence, "" or absent when the list shows none; kind: a ChatKind of shared/slot-db/rows,
// "" or absent when the list shows none
export type ChatEntry = { name: string; preview: string; time: string; unread: boolean; mention: boolean; muted: boolean; av: string; presence?: string; kind?: string };

export const CHAT_LIMIT = 40;

// The chat with yourself ("Name (You)")
export const isSelfChat = (name: string) => name.toLowerCase().includes(TEXTS.selfChat.toLowerCase());

// Teams virtualizes the list: only the rows that fit the window are in the page, and the window changes with
// whoever looks at the remote desktop. The visible chats go first, in Teams order; the others stay, in their
// order. A picture not copied in this round keeps the one already known, and so does a kind this read could not tell.
// replace: the list is complete.
export function mergeChats(visible: readonly ChatEntry[], stored: readonly ChatEntry[], replace: boolean): ChatEntry[] {
  const knownAv = new Map(stored.filter((c) => c.av).map((c) => [c.name, c.av]));
  const knownKind = new Map(stored.filter((c) => c.kind).map((c) => [c.name, c.kind]));
  const rows = visible.map((c) => ({
    ...c,
    ...(!c.av && knownAv.has(c.name) ? { av: knownAv.get(c.name) ?? "" } : {}),
    ...(!c.kind && knownKind.has(c.name) ? { kind: knownKind.get(c.name) } : {}),
  }));
  if (replace) return rows;
  const seen = new Set(visible.map((c) => c.name));
  // a presence is as old as the read that saw it: none rather than a stale one for the chats out of this read
  const others = stored.filter((c) => !seen.has(c.name)).map((c) => ({ ...c, presence: "" }));
  return [...rows, ...others].slice(0, CHAT_LIMIT);
}

// The open title can differ from the list name (names are cut at 60 characters, suffixes such as
// "(External)"), so a prefix still matches, unless the title is another chat of the list:
// "Luca Bianchini" is not "Luca Bianchi".
export function sameChat(title: string, name: string, isKnownChat: (name: string) => boolean): boolean {
  if (!title || !name) return false;
  if (title === name) return true;
  if (!title.startsWith(name) && !name.startsWith(title)) return false;
  return !isKnownChat(title);
}

// The header of the open chat (page script openChatHeader): its title as the list names it, every person a group
// chat without a name shows, the "+N" of the others, the participant count (null where the header shows none)
export type OpenHeader = { title: string; people: string[]; more: number; count: number | null };

// Whether the open chat is `name` of the list. A header that names one person and no "+N" is matched by its title
// (sameChat). A group chat without a name is listed by its first people and "+N" for the others; its header shows as
// many people as fit the window, the others as "+N" too, so the two cut it differently ("Mohamed, Faraz, P, Pravin,
// +4" in the list; "Mohamed, Faraz", "P, Pravin", "Renton, John", "+3" in a wide header, "Mohamed, Faraz", "+5" in a
// narrow one). Names can hold commas ("Surname, Name"): the list name is matched person by person, and its count of
// people against the header. A group header never matches a 1:1 chat, even one named as its first person, and one that
// two chats of the list fit matches neither.
export function isOpenChat(h: OpenHeader, name: string, knownChats: readonly string[]): boolean {
  if (h.people.length < 2 && !h.more) return sameChat(h.title, name, (n) => knownChats.includes(n));
  if (!fitsGroupHeader(h, name)) return false;
  return !knownChats.some((other) => other !== name && fitsGroupHeader(h, other));
}

// People of the chat by its header: the participant count, else the people shown and the "+N" (which counts you)
// or, when everyone fits, the people shown and you (not shown)
const headerTotal = (h: OpenHeader) => h.count ?? h.people.length + (h.more || 1);

function fitsGroupHeader(h: OpenHeader, name: string): boolean {
  if (!h.more && h.people.join(", ") === name) return true;
  const m = /^(.+), \+(\d+)$/.exec(name);
  if (!m) return false;
  const named = m[1];
  const others = Number(m[2]);
  // the list names as many people as the header or fewer
  for (let j = 1; j <= h.people.length; j++) {
    if (h.people.slice(0, j).join(", ") === named) return headerTotal(h) === j + others;
  }
  // the list names more people than the header shows: at least one more
  return named.startsWith(`${h.people.join(", ")}, `) && headerTotal(h) >= h.people.length + 1 + others;
}
