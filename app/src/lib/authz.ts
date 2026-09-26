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

export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
