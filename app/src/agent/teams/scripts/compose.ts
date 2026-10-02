// Page scripts of the compose box. They run inside the Teams page: self-contained, type imports only.
import type { Selectors, Texts } from "../selectors";

// The image goes in as a paste, as when a person pastes one: Teams sends it as an inline image. The file is built
// here from its bytes (base64), so no file path has to exist in the browser container. True when the compose
// box took the paste.
export function pasteImage({ s, name, type, data }: { s: Selectors; name: string; type: string; data: string }): boolean {
  // the compose box, not the editor of a message being edited
  const box = [...document.querySelectorAll<HTMLElement>(s.editor)].find((x) => !x.closest(s.item) && x.offsetParent !== null);
  if (!box) return false;
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], name, { type }));
  box.focus();
  // a compose box that handles the paste cancels it
  return !box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
}

export function messageIds(s: Selectors): string[] {
  return [...document.querySelectorAll(s.message)].map((m) => m.getAttribute("data-mid") || "");
}

// Text, images and people tagged left in the compose box; the marks Teams keeps in an empty box do not count
export function composerLeft(s: Selectors): number {
  const box = [...document.querySelectorAll<HTMLElement>(s.editor)].find((x) => !x.closest(s.item) && x.offsetParent !== null);
  if (!box) return 0;
  return (box.textContent || "").replace(/[\s⁠​ ]/g, "").length + box.querySelectorAll("img").length + box.querySelectorAll(s.composerMention).length;
}

export function composerImages(s: Selectors): number {
  const box = [...document.querySelectorAll<HTMLElement>(s.editor)].find((x) => !x.closest(s.item) && x.offsetParent !== null);
  return box ? box.querySelectorAll("img").length : 0;
}

// A message of yours, not among `before`, whose status icon says Teams has it: not sending any more (it then also
// has its final id), not failed. Teams draws the icon under the last message of yours only: without it, nothing is
// known yet. `image`: the message must hold an image. `names`: people the message must tag, every one of them.
export function ownMessageSent({ s, t, before, image = false, names = [] }: { s: Selectors; t: Texts; before: string[]; image?: boolean; names?: string[] }): boolean {
  const known = new Set(before);
  return [...document.querySelectorAll(s.message)].some((m) => {
    const mid = m.getAttribute("data-mid") || "";
    const mine = m.closest(s.mine) || m.querySelector(s.mine);
    if (!mid || known.has(mid) || !mine) return false;
    const icon = mine.querySelector(s.statusIcon);
    const status = ((icon && icon.getAttribute("aria-label")) || "").trim();
    if (!status || t.sending.test(status) || t.sendFailed.test(status)) return false;
    if (image && ![...m.querySelectorAll("img")].some((i) => s.imageType.test(i.getAttribute("itemtype") || "") || s.lazyImage.test(i.getAttribute("data-tid") || ""))) return false;
    if (!names.length) return true;
    const tagged = [...m.querySelectorAll("[itemtype]")]
      .filter((e) => s.mentionType.test(e.getAttribute("itemtype") || ""))
      .map((e) => (e.textContent || "").replace(/[\s ]+/g, " ").trim());
    return names.every((n) => tagged.includes(n));
  });
}
