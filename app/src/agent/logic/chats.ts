// A chat of the Teams list, as the agent keeps it (tm in the chats table is time here)
// presence: a word of shared/presence, "" or absent when the list shows none
export type ChatEntry = { name: string; preview: string; time: string; unread: boolean; mention: boolean; muted: boolean; av: string; presence?: string };

export const CHAT_LIMIT = 40;

// Teams virtualizes the list: only the rows that fit the window are in the page, and the window changes with
// whoever looks at the remote desktop. The visible chats go first, in Teams order; the others stay, in their
// order. A picture not copied in this round keeps the one already known. replace: the list is complete.
export function mergeChats(visible: readonly ChatEntry[], stored: readonly ChatEntry[], replace: boolean): ChatEntry[] {
  const knownAv = new Map(stored.filter((c) => c.av).map((c) => [c.name, c.av]));
  const rows = visible.map((c) => (!c.av && knownAv.has(c.name) ? { ...c, av: knownAv.get(c.name) ?? "" } : c));
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
