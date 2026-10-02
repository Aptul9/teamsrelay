// Page scripts of the @ in the compose box. They run inside the Teams page: self-contained, type imports only.
import type { Selectors } from "../selectors";

type Point = { x: number; y: number };

// Centre of the entry of exactly `name` in the list the @ opened, a person only; null while it is not listed, or
// while something covers it (the toast of an incoming call would take the click)
export function mentionOptionPoint({ s, name }: { s: Selectors; name: string }): Point | null {
  const popup = document.querySelector(s.mentionPopup);
  if (!popup) return null;
  const option = [...popup.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (o) => o.getAttribute("itemtype") === "person" && o.getAttribute("data-tid") === s.mentionOptionPrefix + name && o.getClientRects().length > 0,
  );
  if (!option) return null;
  option.scrollIntoView({ block: "nearest" });
  const r = option.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return hit && option.contains(hit) ? { x, y } : null;
}

// People tagged in the compose box, by name as Teams shows them (one element per word of the name)
export function composerMentionNames(s: Selectors): string[] {
  const box = [...document.querySelectorAll<HTMLElement>(s.editor)].find((x) => !x.closest(s.item) && x.offsetParent !== null);
  if (!box) return [];
  return [...box.querySelectorAll(s.composerMention)].map((m) => (m.textContent || "").replace(/[\s ]+/g, " ").trim()).filter(Boolean);
}
