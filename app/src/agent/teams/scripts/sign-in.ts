// Page scripts of a sign-out (src/agent/jobs/sign-in.ts): what the agent may press, once, so that the session the
// browser still holds signs in by itself. Everything is found by its text and pressed only when exactly one is on
// screen. They run inside the page: self-contained, type imports only.
import type { Selectors, Texts } from "../selectors";

type Point = { x: number; y: number };

type SignInPage = {
  // Teams' own Sign in, while Teams says to sign in again
  teams: { asks: boolean; found: number; at: Point | null };
  // Microsoft's sign-in page: whether it asks for something to type (a password, a code, an email: then nothing is
  // pressed), the tile of this account (its email as a whole word, or as data-test-id), the one Sign in or Continue
  microsoft: { asks: boolean; accounts: number; account: Point | null; buttons: number; button: Point | null };
  // the buttons, tiles and links on screen by their text, once each, for the log of a sign-out: the next real one says
  // what those pages show
  buttons: string[];
};

// What a page of a sign-out shows. Points are of a part nothing covers, and only when exactly one shows.
export function signInPage({ s, t, email = "" }: { s: Selectors; t: Texts; email?: string }): SignInPage {
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
  const clickable = [...document.querySelectorAll(s.clickable)].filter(shown);
  const buttons = [...new Set(clickable.map((e) => label(e).slice(0, 40)).filter(Boolean))].slice(0, 30);

  const sessionLost = t.sessionLost.test((document.body && document.body.innerText) || "");
  const signIns = clickable.filter((e) => t.signInButton.test(label(e)));
  const teams = { asks: sessionLost, found: signIns.length, at: sessionLost && signIns.length === 1 ? free(signIns[0]) : null };

  // fields that take no typing: buttons, boxes to tick, hidden ones
  const untyped = ["hidden", "submit", "button", "checkbox", "radio", "image", "reset"];
  const fields = [...document.querySelectorAll<HTMLInputElement>(s.fields)].filter(shown).filter((f) => f.tagName !== "INPUT" || !untyped.includes((f.type || "text").toLowerCase()));
  if (fields.length) return { teams, microsoft: { asks: true, accounts: 0, account: null, buttons: 0, button: null }, buttons };
  const own = email.trim().toLowerCase();
  const word = new RegExp(`(^|[^a-z0-9._%+-])${own.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9._%+-])`, "i");
  const named = own
    ? [...document.querySelectorAll(`${s.clickable},${s.accountTile}`)]
        .filter(shown)
        .filter((e) => (e.getAttribute("data-test-id") || "").toLowerCase() === own || (e.matches(s.clickable) && word.test((e as HTMLElement).innerText || "")))
    : [];
  // a tile and an element inside it that name the same account are one: the innermost
  const accounts = named.filter((e) => !named.some((o) => o !== e && e.contains(o)));
  const continues = clickable.filter((e) => t.microsoftButton.test(label(e)));
  return {
    teams,
    microsoft: {
      asks: false,
      accounts: accounts.length,
      account: accounts.length === 1 ? free(accounts[0]) : null,
      buttons: continues.length,
      button: continues.length === 1 ? free(continues[0]) : null,
    },
    buttons,
  };
}
