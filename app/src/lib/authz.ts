import { appDb, slotRow, type Slot } from "./appdb";
import { HttpError } from "./http";

// Slot of a per-account request: the ?a=N parameter, or the first owned slot when missing.
// A slot owned by someone else answers like a slot that does not exist.
export function pickSlot(owned: number[], param: string | null): number {
  if (!param) {
    if (owned.length) return owned[0];
    throw new HttpError(404, "Account not found");
  }
  const n = /^\d+$/.test(param) ? Number(param) : NaN;
  if (!owned.includes(n)) throw new HttpError(404, "Account not found");
  return n;
}

// The row of an account of this user named by a path parameter; any other slot answers like one that does not exist
export function ownedSlot(userId: string, param: string): Slot {
  const n = Number(param);
  const row = Number.isInteger(n) ? slotRow(appDb(), n) : null;
  if (!row || row.owner_id !== userId) throw new HttpError(404, "Account not found");
  return row;
}

// A path of this site to go to after the sign-in. Browsers read a backslash as a slash and drop tab, CR and LF, so
// "/\evil.example" or "/<tab>/evil.example" would be another site: such paths, and whatever resolves elsewhere, go to /
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || /[\u0000-\u001f\\]/.test(next)) return "/";
  return new URL(next, "http://relay.invalid").origin === "http://relay.invalid" ? next : "/";
}

// The sign-in page, then `next`
export const loginUrl = (next: string) => `/login?next=${encodeURIComponent(next)}`;

// The sign-in page for a visit to the app without a session: the account asked by a tapped notification (a) and the
// start page of the Android app (app) come back with the page after the sign-in
export function loginFor(params: Record<string, string | string[] | undefined>): string {
  const back = new URLSearchParams();
  for (const k of ["a", "app"]) {
    const v = params[k];
    if (typeof v === "string" && v) back.set(k, v);
  }
  return String(back) ? loginUrl(`/?${back}`) : "/login";
}
