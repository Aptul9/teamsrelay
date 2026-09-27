// Page scripts of the @ in the compose box. They run inside the Teams page: self-contained, type imports only.
import type { Selectors, Texts } from "../selectors";

type Point = { x: number; y: number };

// Centre of the entry of exactly `name` in the list the @ opened, a person only; null while it is not listed
export function mentionOptionPoint({ s, name }: { s: Selectors; name: string }): Point | null {
  const popup = document.querySelector(s.mentionPopup);
  if (!popup) return null;
  const option = [...popup.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (o) => o.getAttribute("itemtype") === "person" && o.getAttribute("data-tid") === s.mentionOptionPrefix + name && o.getClientRects().length > 0,
  );
  if (!option) return null;
  option.scrollIntoView({ block: "nearest" });
  const r = option.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// People tagged in the compose box, by name as Teams shows them (one element per word of the name)
export function composerMentionNames(s: Selectors): string[] {
  const box = [...document.querySelectorAll<HTMLElement>(s.editor)].find((x) => !x.closest(s.item) && x.offsetParent !== null);
  if (!box) return [];
  return [...box.querySelectorAll(s.composerMention)].map((m) => (m.textContent || "").replace(/[\s ]+/g, " ").trim()).filter(Boolean);
}

// A new message of yours (not among `before`), whose status icon says Teams has it (see ownMessageSent in
// compose.ts), that tags every one of `names`
export function mentionMessageSent({ s, t, before, names }: { s: Selectors; t: Texts; before: string[]; names: string[] }): boolean {
  const known = new Set(before);
  return [...document.querySelectorAll(s.message)].some((m) => {
    const mid = m.getAttribute("data-mid") || "";
    const mine = m.closest(s.mine) || m.querySelector(s.mine);
    if (!mid || known.has(mid) || !mine) return false;
    const icon = mine.querySelector(s.statusIcon);
    const status = ((icon && icon.getAttribute("aria-label")) || "").trim();
    if (!status || t.sending.test(status) || t.sendFailed.test(status)) return false;
    const tagged = [...m.querySelectorAll("[itemtype]")]
      .filter((e) => s.mentionType.test(e.getAttribute("itemtype") || ""))
      .map((e) => (e.textContent || "").replace(/[\s ]+/g, " ").trim());
    return names.every((n) => tagged.includes(n));
  });
}
