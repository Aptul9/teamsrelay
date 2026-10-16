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

// Whether the open chat is `name` of the list. A header that names one person is matched by its title (sameChat).
// A group chat without a name is listed by its first people and "+N" for the others, and its header shows as many
// people as fit: the two cut it differently ("Mohamed, Faraz, P, Pravin, +4" in the list; "Mohamed, Faraz",
// "P, Pravin", "Renton, John", "+3" in the header). Names can hold commas ("Surname, Name"), so the list name is
// matched person by person, and the people it counts against the participant count of the header. Such a header is
// never a 1:1 chat, even when its first person is the name of one.
export function isOpenChat(h: OpenHeader, name: string, isKnownChat: (name: string) => boolean): boolean {
  if (h.people.length < 2) return sameChat(h.title, name, isKnownChat);
  if (h.people.join(", ") === name) return true;
  const m = /^(.+), \+(\d+)$/.exec(name);
  if (!m) return false;
  const [, named, others] = m;
  for (let j = 1; j <= h.people.length; j++) {
    if (h.people.slice(0, j).join(", ") === named) return h.count === null || h.count === j + Number(others);
  }
  return false;
}
