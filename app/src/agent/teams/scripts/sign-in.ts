// Page scripts of a sign-out (src/agent/jobs/sign-in.ts): what the agent may press, once, so that the session the
// browser still holds signs in by itself. Everything is found by its text and pressed only when exactly one is on
// screen. They run inside the page: self-contained, type imports only.
import type { Selectors, Texts } from "../selectors";

type Point = { x: number; y: number };

// Teams' own Sign in, while Teams says to sign in again: a point of it nothing covers, only when exactly one shows
export function teamsSignIn({ s, t }: { s: Selectors; t: Texts }): { asks: boolean; found: number; at: Point | null } {
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const label = (e: Element) => ((e as HTMLElement).innerText || (e as HTMLInputElement).value || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  // a point where the element itself takes the click: not covered, not on another button inside it
  const free = (e: Element): Point | null => {
    const r = e.getBoundingClientRect();
    for (const fy of [0.5, 0.25, 0.75]) {
      for (const fx of [0.5, 0.25, 0.75]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === e || e.contains(hit)) && (hit.closest(s.clickable) ?? e) === e) return { x, y };
      }
    }
    return null;
  };
  const asks = t.sessionLost.test((document.body && document.body.innerText) || "");
  const found = [...document.querySelectorAll(s.clickable)].filter(shown).filter((e) => t.signInButton.test(label(e)));
  return { asks, found: found.length, at: asks && found.length === 1 ? free(found[0]) : null };
}

// Microsoft's sign-in page: whether it asks for something to type (a password, a code, an email: then nothing is
// pressed), the tile of this account (its email as a whole word, or as data-test-id), the one Sign in or Continue.
// Points nothing covers, only when exactly one shows.
export function microsoftSignIn({ s, t, email }: { s: Selectors; t: Texts; email: string }): {
  asks: boolean;
  accounts: number;
  account: Point | null;
  buttons: number;
  button: Point | null;
} {
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const label = (e: Element) => ((e as HTMLElement).innerText || (e as HTMLInputElement).value || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const free = (e: Element): Point | null => {
    const r = e.getBoundingClientRect();
    for (const fy of [0.5, 0.25, 0.75]) {
      for (const fx of [0.5, 0.25, 0.75]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === e || e.contains(hit)) && (hit.closest(s.clickable) ?? e) === e) return { x, y };
      }
    }
    return null;
  };
  // fields that take no typing: buttons, boxes to tick, hidden ones
  const untyped = ["hidden", "submit", "button", "checkbox", "radio", "image", "reset"];
  const fields = [...document.querySelectorAll<HTMLInputElement>(s.fields)].filter(shown).filter((f) => f.tagName !== "INPUT" || !untyped.includes((f.type || "text").toLowerCase()));
  if (fields.length) return { asks: true, accounts: 0, account: null, buttons: 0, button: null };
  const own = email.trim().toLowerCase();
  const word = new RegExp(`(^|[^a-z0-9._%+-])${own.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9._%+-])`, "i");
  const named = own
    ? [...document.querySelectorAll(`${s.clickable},${s.accountTile}`)]
        .filter(shown)
        .filter((e) => (e.getAttribute("data-test-id") || "").toLowerCase() === own || (e.matches(s.clickable) && word.test((e as HTMLElement).innerText || "")))
    : [];
  // a tile and an element inside it that name the same account are one: the innermost
  const accounts = named.filter((e) => !named.some((o) => o !== e && e.contains(o)));
  const buttons = [...document.querySelectorAll(s.clickable)].filter(shown).filter((e) => t.microsoftButton.test(label(e)));
  return {
    asks: false,
    accounts: accounts.length,
    account: accounts.length === 1 ? free(accounts[0]) : null,
    buttons: buttons.length,
    button: buttons.length === 1 ? free(buttons[0]) : null,
  };
}

// The buttons, tiles and links on screen by their text, once each, for the log of a sign-out: the next real one says
// what those pages show
export function visibleButtons(s: Selectors): string[] {
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const labels = [...document.querySelectorAll(s.clickable)]
    .filter(shown)
    .map((e) => ((e as HTMLElement).innerText || (e as HTMLInputElement).value || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 40))
    .filter(Boolean);
  return [...new Set(labels)].slice(0, 30);
}
