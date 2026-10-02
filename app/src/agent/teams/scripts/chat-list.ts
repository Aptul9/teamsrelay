// Page scripts of the chat list. They run inside the Teams page (page.evaluate): self-contained, type
// imports only, selectors and texts come in as argument.
import type { Selectors, Texts } from "../selectors";

// presence: the label of the badge on the picture of the person ("Away"), "" on a group chat; kind: one (1:1), group,
// meeting, "" where the row names none
export type ListRow = { name: string; preview: string; time: string; unread: boolean; mention: boolean; muted: boolean; avsrc: string; presence: string; kind: string };
type ListArgs = { s: Selectors; t: Texts };

// Chats are the level-2 rows of the Chats and Favorites sections; Quick views (Mentions, Drafts) are not.
// A closed section has no rows in the page, so it is opened.
export function readChatList({ s, t }: ListArgs): ListRow[] {
  const header = (sec: Element) => (sec.querySelector(s.sectionHeader) || sec) as HTMLElement;
  const headText = (sec: Element) => (header(sec).innerText || "").replace(/\s+/g, " ").trim();
  for (const sec of document.querySelectorAll(s.collapsedSection)) {
    if (t.listSection.test(headText(sec))) header(sec).click();
  }
  const rows = [...document.querySelectorAll<HTMLElement>(s.chatRow)].filter((e) => {
    const sec = e.parentElement && e.parentElement.closest(s.section);
    return !!sec && t.listSection.test(headText(sec));
  });
  const out: ListRow[] = [];
  const seen = new Set<string>();
  for (const e of rows) {
    const text = (e.innerText || "").replace(/\s+/g, " ").trim();
    if (!text || t.listNoise.test(text)) continue;
    const unread = !!e.querySelector(s.unread);
    const clean = text.replace(t.listPrefix, "").replace(t.statusWords, "").replace(/\s+/g, " ").trim();
    const tm = clean.match(t.listTime);
    const time = tm ? tm[0].trim() : "";
    let name = clean.split(t.listNameEnd)[0].trim();
    if (!name) name = clean.slice(0, 40);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    let preview = clean;
    if (time) {
      const i = clean.indexOf(time);
      if (i > -1) preview = clean.slice(i + time.length).trim();
    } else {
      preview = clean.slice(name.length).trim();
    }
    const label = e.getAttribute("aria-label") || "";
    const mention = !!e.querySelector(s.mention) || t.mentionLabel.test(label);
    // a muted chat says so on the row and shows a crossed bell instead of the picture
    const muted = e.getAttribute("data-item-type") === s.mutedItemType || !!e.querySelector(s.mutedIcon);
    const avatar = e.querySelector<HTMLImageElement>(s.avatar);
    const avsrc = avatar && avatar.naturalWidth ? avatar.currentSrc || avatar.src : "";
    const presence = (e.querySelector(s.rowPresence)?.getAttribute("aria-label") || "").trim().slice(0, 60);
    const ids = (e.getAttribute("aria-labelledby") || "").split(/\s+/);
    const kind = ids.includes(s.rowOneOnOne) ? "one" : ids.includes(s.rowGroup) ? "group" : ids.includes(s.rowMeeting) ? "meeting" : "";
    out.push({ name: name.slice(0, 60), preview: preview.slice(0, 120), time, unread, mention, muted, avsrc, presence, kind });
    if (out.length >= 40) break;
  }
  return out;
}

// Clicks the row of chat `name`. Row names are parsed as in readChatList; the exact name wins, a prefix is used
// only when a single row matches it and `exact` is not asked. No match or an ambiguous prefix: nothing is clicked.
export function clickChatRow({ s, t, name, exact }: ListArgs & { name: string; exact?: boolean }): boolean {
  const header = (sec: Element) => (sec.querySelector(s.sectionHeader) || sec) as HTMLElement;
  const headText = (sec: Element) => (header(sec).innerText || "").replace(/\s+/g, " ").trim();
  // chats only (level 2): the header of the Chats section holds the text of the first chat, and a click closes it
  const rows = [...document.querySelectorAll<HTMLElement>(s.chatRow)].filter((e) => {
    const sec = e.parentElement && e.parentElement.closest(s.section);
    return !!sec && t.listSection.test(headText(sec));
  });
  const rowName = (e: HTMLElement) => {
    const clean = (e.innerText || "").replace(/\s+/g, " ").trim().replace(t.listPrefix, "").replace(t.statusWords, "").replace(/\s+/g, " ").trim();
    const n = clean.split(t.listNameEnd)[0].trim();
    return (n || clean.slice(0, 40)).slice(0, 60);
  };
  const names = rows.map(rowName);
  let i = names.indexOf(name);
  if (i < 0 && !exact) {
    const prefixed = names.map((n, k) => (n.startsWith(name) ? k : -1)).filter((k) => k >= 0);
    if (prefixed.length === 1) i = prefixed[0];
  }
  if (i < 0) return false;
  // the only button inside the row is "More chat options" (Hide, Remove chat history...): the row itself is clicked
  rows[i].click();
  return true;
}

// Name of the chat open in Teams, so the messages of one chat are never saved under the name of another
// The title of the open chat, as the list names it: a group chat without a name shows its first person, and the
// others as "+N" on a line of their own, where the list says "Anna Rossi, +2"
export function openChatTitle(s: Selectors): string {
  const title = document.querySelector<HTMLElement>(s.chatTitle);
  if (!title) return "";
  const [first = "", next = ""] = (title.innerText || "").split("\n").map((line) => line.trim());
  return /^\+\d+$/.test(next) ? `${first}, ${next}` : first;
}

// Scrolls a virtualized list (the chats, the Activity feed), found by one of its `item`s, to the top or down by most of
// a screen. True when it moved.
export function scrollList({ item, to }: { item: string; to: "top" | "down" }): boolean {
  let e: HTMLElement | null = document.querySelector<HTMLElement>(item);
  while (e && !(e.scrollHeight > e.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(e).overflowY))) e = e.parentElement;
  if (!e) return false;
  const before = e.scrollTop;
  e.scrollTop = to === "top" ? 0 : before + e.clientHeight * 0.8;
  return e.scrollTop !== before;
}
