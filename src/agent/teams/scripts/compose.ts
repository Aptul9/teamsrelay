// Page scripts of the compose box. They run inside the Teams page: self-contained, type imports only.
import type { Selectors, Texts } from "../selectors";

export function messageIds(s: Selectors): string[] {
  return [...document.querySelectorAll(s.message)].map((m) => m.getAttribute("data-mid") || "");
}

// Text, images and people tagged left in the compose box; the marks Teams keeps in an empty box do not count
export function composerLeft(s: Selectors): number {
  const box = [...document.querySelectorAll<HTMLElement>(s.editor)].find((x) => !x.closest(s.item) && x.offsetParent !== null);
  if (!box) return 0;
  return (box.textContent || "").replace(/[\s⁠​ ]/g, "").length + box.querySelectorAll("img").length + box.querySelectorAll(s.composerMention).length;
}

// A message of yours, not among `before`, that Teams no longer shows as sending (it then also has its final id)
export function ownMessageSent({ s, t, before }: { s: Selectors; t: Texts; before: string[] }): boolean {
  const known = new Set(before);
  return [...document.querySelectorAll(s.message)].some((m) => {
    const mid = m.getAttribute("data-mid") || "";
    const mine = m.closest(s.mine) || m.querySelector(s.mine);
    if (!mid || known.has(mid) || !mine) return false;
    const icon = mine.querySelector(s.statusIcon);
    return !t.sending.test((icon && icon.getAttribute("aria-label")) || "");
  });
}
