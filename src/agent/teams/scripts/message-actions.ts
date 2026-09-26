// Page scripts used around the actions on a message (react, edit, reply, delete). They run inside
// the Teams page: self-contained, type imports only. A message is found by its data-mid.
import type { Selectors } from "../selectors";

type Point = { x: number; y: number };
type MessageArgs = { s: Selectors; mid: string };

// Teams draws the action bars in a portal outside the message and more than one can be visible: the one
// closest to the message wins, within 120 px. Center of button `tid` of that bar, null when not visible.
export function barButtonPoint({ s, mid, tid }: MessageArgs & { tid: string }): Point | null {
  const m = document.querySelector(`${s.message}[data-mid="${CSS.escape(mid)}"]`);
  if (!m) return null;
  const r = m.getBoundingClientRect();
  const bars = [...document.querySelectorAll<HTMLElement>(s.actionBar)].filter((b) => b.offsetParent !== null);
  let best: HTMLElement | null = null;
  let distance = 1e9;
  for (const b of bars) {
    const q = b.getBoundingClientRect();
    const d = Math.abs((q.top + q.bottom) / 2 - (r.top + Math.min(r.height, 40) / 2));
    if (d < distance) {
      distance = d;
      best = b;
    }
  }
  if (!best || distance > 120) return null;
  const btn = best.querySelector<HTMLElement>(`[data-tid="${CSS.escape(tid)}"]`);
  if (!btn || btn.offsetParent === null) return null;
  const q = btn.getBoundingClientRect();
  return { x: q.left + q.width / 2, y: q.top + q.height / 2 };
}

// The pill of reaction `emoji` under the message: center and whether it is yours
export function reactionPill({ s, mid, emoji }: MessageArgs & { emoji: string }): (Point & { found: true; pressed: boolean }) | { found: false } | null {
  const m = document.querySelector(`${s.message}[data-mid="${CSS.escape(mid)}"]`);
  if (!m) return null;
  const item = m.closest(s.item) || m;
  const pill = [...item.querySelectorAll<HTMLElement>(s.pill)].find((x) => [...x.querySelectorAll("img")].some((i) => i.alt === emoji));
  if (!pill) return { found: false };
  const r = pill.getBoundingClientRect();
  return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, pressed: pill.getAttribute("aria-pressed") === "true" };
}

// Your reactions under the message, by the id Teams gives each pill
export function ownReactions({ s, mid }: MessageArgs): string[] {
  const m = document.querySelector(`${s.message}[data-mid="${CSS.escape(mid)}"]`);
  if (!m) return [];
  const item = m.closest(s.item) || m;
  return [...item.querySelectorAll(`${s.pill}[aria-pressed="true"]`)].map((x) => (x.getAttribute("aria-labelledby") || "").split("-")[1] || "");
}

// Menus and dialogs left open over the chat, which would catch the mouse
export function openOverlays(s: Selectors): number {
  return [...document.querySelectorAll(s.overlays)].filter((e) => e.getClientRects().length).length;
}

export function messageCount(s: Selectors): number {
  return document.querySelectorAll(s.message).length;
}

export function isOwnMessage({ s, mid }: MessageArgs): boolean {
  const m = document.querySelector(`${s.message}[data-mid="${CSS.escape(mid)}"]`);
  return !!(m && m.closest(s.mine));
}

// The quote of "Reply with quote" appears above the compose box, outside the messages
export function quoteBoxReady(s: Selectors): boolean {
  return [...document.querySelectorAll(s.closeQuote)].some((x) => !x.closest(s.item));
}

// Text in the compose box (not the editor of a message being edited)
export function composerText(s: Selectors): string {
  const box = [...document.querySelectorAll<HTMLElement>(s.editor)].find((x) => !x.closest(s.item) && x.offsetParent !== null);
  return box ? box.innerText : "";
}

// A message was added after the first `before` ones, with a quote and `text` in it
export function lastMessageQuotes({ s, before, text }: { s: Selectors; before: number; text: string }): boolean {
  const all = [...document.querySelectorAll(s.message)];
  if (all.length <= before) return false;
  const item = all[all.length - 1].closest<HTMLElement>(s.item);
  return !!item && !!item.querySelector(s.quote) && (item.innerText || "").includes(text);
}

export function deletedState({ s, mid }: MessageArgs): "deleted" | "present" | "missing" {
  const m = document.querySelector(`${s.message}[data-mid="${CSS.escape(mid)}"]`);
  const item = m && m.closest(s.item);
  if (!item) return "missing";
  return item.querySelector(s.tombstone) ? "deleted" : "present";
}

// Center of the Undo button of a message just deleted, scrolled into view
export function undoButtonPoint({ s, mid }: MessageArgs): Point | null {
  const m = document.querySelector(`${s.message}[data-mid="${CSS.escape(mid)}"]`);
  const item = m && m.closest(s.item);
  const btn = item && item.querySelector(s.undoDelete);
  if (!btn) return null;
  btn.scrollIntoView({ block: "center" });
  const r = btn.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// Current text of the body of a message, null when it is not in the page
export function messageBodyText(mid: string): string | null {
  const body = document.getElementById(`content-${mid}`);
  return body ? body.innerText.trim() : null;
}

export function centerElement(el: Element) {
  el.scrollIntoView({ block: "center" });
}
