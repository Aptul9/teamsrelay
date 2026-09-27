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

// A path of this site to go to after the sign-in; browsers read a backslash as a slash, so "/\\evil.example" would be
// another site
export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/";
}

// The sign-in page for a visit to the app without a session: the account asked by a tapped notification (a) and the
// start page of the Android app (app) come back with the page after the sign-in
export function loginFor(params: Record<string, string | string[] | undefined>): string {
  const back = new URLSearchParams();
  for (const k of ["a", "app"]) {
    const v = params[k];
    if (typeof v === "string" && v) back.set(k, v);
  }
  return String(back) ? `/login?next=${encodeURIComponent(`/?${back}`)}` : "/login";
}
