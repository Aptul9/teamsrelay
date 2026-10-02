import { loginUrl, ownedSlot } from "@/lib/authz";
import { controlClient } from "@/lib/control";
import { HttpError, route } from "@/lib/http";
import { ON_ANOTHER_COMPUTER } from "@/lib/relay";
import { currentUser } from "@/lib/session";
import { withSlotOr } from "@/lib/slotdb";

type Ctx = { params: Promise<{ slot: string }> };

const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location } });

// An account of this user whose window is on the desktop
function ownAccount(userId: string, slot: string): number {
  const row = ownedSlot(userId, slot);
  if (row.relay) throw new HttpError(409, ON_ANOTHER_COMPUTER);
  return row.slot;
}

// The window of the account to the front of the one desktop; false when the supervisor could not do it
async function toFront(n: number): Promise<boolean> {
  // the agent leaves Teams to the owner from now: no chat switch, no presence keeper while the owner looks
  withSlotOr(n, (r) => r.markDesktop(), undefined);
  return controlClient()
    .show(n)
    .catch(() => false);
}

// Remote desktop of one account. Every account has its browser window on the one desktop of the browsers
// container: the window of this account comes to the front, then the desktop opens.
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await currentUser(req.headers);
  if (!user) return redirect(loginUrl(new URL(req.url).pathname));
  const n = ownAccount(user.id, (await params).slot);
  // the desktop is still useful with the windows as they are
  await toFront(n);
  return redirect("/desktop/");
});

// Another account to the front of the desktop already on screen (the switcher of /remote): no redirect, the desktop
// stays connected
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await currentUser(req.headers);
  if (!user) throw new HttpError(401, "Not signed in");
  const n = ownAccount(user.id, (await params).slot);
  return Response.json({ ok: true, shown: await toFront(n) });
});
