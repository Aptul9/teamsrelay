// Page scripts of the Teams Activity feed: reactions to your messages, mentions, replies, calls, invitations.
// They run inside the Teams page: self-contained, type imports only.
import type { ActivityKind } from "@/shared/slot-db/rows";
import type { Selectors, Texts } from "../selectors";

export type FeedItem = {
  id: string;
  title: string;
  kind: ActivityKind;
  actor: string;
  emoji: string;
  preview: string;
  tm: string;
  chat: string;
  channel: boolean;
  unread: boolean;
  avsrc: string;
};

// The items the feed has in the page (it is virtualized: scrollActivityFeed brings the next ones)
export function readActivityFeed({ s, t }: { s: Selectors; t: Texts }): FeedItem[] {
  return [...document.querySelectorAll<HTMLElement>(s.feedItem)].map((it) => {
    const id = ((it.getAttribute("aria-labelledby") || "").match(s.feedItemId) || [])[1] || "";
    const titleEl = it.querySelector<HTMLElement>(s.feedTitle);
    const title = titleEl ? (titleEl.innerText || "").replace(/\s+/g, " ").trim() : "";
    // text outside the title and outside buttons (item menu, "Call" and "Chat" of a missed call)
    const leaves = [...it.querySelectorAll("*")]
      .filter((x) => x.children.length === 0 && (x.textContent || "").trim() && !(titleEl && titleEl.contains(x)) && !x.closest("button"))
      .map((x) => (x.textContent || "").replace(/\s+/g, " ").trim());
    let ti = leaves.findIndex((x) => t.feedTime.test(x));
    if (ti < 0) ti = leaves.length;
    const tm = leaves[ti] || "";
    const preview = leaves.slice(0, ti).join(" ");
    const place = leaves.slice(ti + 1);
    const emoji = [...it.querySelectorAll("img")].map((i) => i.alt || "").filter(Boolean).join("");
    // the person comes before the action, except in "Missed call from Anna Rossi"
    const call = title.match(t.missedCall);
    const actor = call ? call[1].trim() : title.replace(t.feedAction, "").trim();
    let kind: ActivityKind = call
      ? "call"
      : t.feedReaction.test(title)
        ? "reaction"
        : t.feedMention.test(title)
          ? "mention"
          : t.feedReply.test(title)
            ? "reply"
            : t.feedTask.test(title)
              ? "task"
              : t.feedTeam.test(title)
                ? "team"
                : "message";
    // a channel is written "Team > Channel" on one line, or on two
    const channel = place.length > 1 || /\s>\s/.test(place.join(" "));
    let chat = place.join(" › ").replace(/\s+>\s+/g, " › ");
    // 1:1 chat: the place is the person
    if (t.inChatWithYou.test(chat) || call) chat = actor;
    // meeting invitation
    if (t.meetingTime.test(chat)) kind = "meeting";
    const weight = parseInt(getComputedStyle(titleEl || it).fontWeight, 10) || 400;
    const avatar = [...it.querySelectorAll("img")].find((i) => !i.alt && i.naturalWidth);
    return { id, title, kind, actor, emoji, preview: preview.slice(0, 300), tm, chat, channel, unread: weight >= 600, avsrc: avatar ? avatar.currentSrc || avatar.src : "" };
  });
}

// Scrolls the feed down by most of a screen. True when it moved.
export function scrollActivityFeed(s: Selectors): boolean {
  let e: HTMLElement | null = document.querySelector<HTMLElement>(s.feedItem);
  while (e && !(e.scrollHeight > e.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(e).overflowY))) e = e.parentElement;
  if (!e) return false;
  const before = e.scrollTop;
  e.scrollTop = before + e.clientHeight * 0.8;
  return e.scrollTop > before;
}
