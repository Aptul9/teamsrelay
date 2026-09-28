import { appDb, slotOwner, slotsOf } from "./appdb";
import { auth } from "./auth";
import { pickSlot } from "./authz";
import { HttpError } from "./http";

export type SessionUser = { id: string; email: string; name: string; role?: string | null };

export async function currentUser(headers: Headers): Promise<SessionUser | null> {
  const s = await auth().api.getSession({ headers });
  return s?.user ?? null;
}

// The user and the id of the session of a request: what lasts only as long as that session (a phone of the Android app,
// src/lib/auth.ts) keeps the id
export async function requireSession(req: Request): Promise<{ user: SessionUser; session: string }> {
  const s = await auth().api.getSession({ headers: req.headers });
  if (!s) throw new HttpError(401, "Not signed in");
  return { user: s.user, session: s.session.id };
}

export async function requireUser(req: Request): Promise<SessionUser> {
  const user = await currentUser(req.headers);
  if (!user) throw new HttpError(401, "Not signed in");
  return user;
}

export async function requireAdmin(req: Request): Promise<SessionUser> {
  const user = await requireUser(req);
  if (user.role !== "admin") throw new HttpError(403, "Administrators only");
  return user;
}

// Per-account requests: ?a=N must be a slot of the session user, administrators included.
export async function requireSlot(req: Request): Promise<{ user: SessionUser; slot: number; added: number }> {
  const user = await requireUser(req);
  const owned = slotsOf(appDb(), user.id);
  const slot = pickSlot(
    owned.map((s) => s.slot),
    new URL(req.url).searchParams.get("a"),
  );
  return { user, slot, added: owned.find((s) => s.slot === slot)!.added };
}

// Requests on /api/accounts/N: the owner, or an administrator freeing or switching off a slot
export async function requireAccount(req: Request, slotParam: string): Promise<number> {
  const user = await requireUser(req);
  const n = Number(slotParam);
  const owner = Number.isInteger(n) ? slotOwner(appDb(), n) : null;
  if (!owner || (owner !== user.id && user.role !== "admin")) throw new HttpError(404, "Account not found");
  return n;
}
