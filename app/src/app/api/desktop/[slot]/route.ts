import { setTimeout as wait } from "node:timers/promises";
import { appDb } from "@/lib/appdb";
import { loginUrl, ownedSlot } from "@/lib/authz";
import { controlClient } from "@/lib/control";
import { HttpError, route } from "@/lib/http";
import { browserOnDemand } from "@/lib/light";
import { ON_ANOTHER_COMPUTER } from "@/lib/relay";
import { currentUser } from "@/lib/session";
import { withSlotOr } from "@/lib/slotdb";

type Ctx = { params: Promise<{ slot: string }> };

// Seconds the window of a browser just started may take to show on the desktop
const WINDOW_WAIT = 45;
const NOT_STARTED = "The browser of this account did not start: open it again in a minute";

const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location } });

// An account of this user whose window is on the desktop, or comes there: a light account gets its browser on demand.
// light: its window may still be showing up.
async function ownAccount(userId: string, slot: string): Promise<{ n: number; light: boolean }> {
  const row = ownedSlot(userId, slot);
  if (row.relay) throw new HttpError(409, ON_ANOTHER_COMPUTER);
  if (!(await browserOnDemand(appDb(), row.slot))) throw new HttpError(503, NOT_STARTED);
  return { n: row.slot, light: !!row.light };
}

// The window of the account to the front of the one desktop, the window of a browser just started waited for; false
// when the supervisor could not do it
async function toFront(n: number, waitWindow: boolean): Promise<boolean> {
  // the agent leaves Teams to the owner from now: no chat switch, no presence keeper while the owner looks
  withSlotOr(n, (r) => r.markDesktop(), undefined);
  for (let i = 0; ; i++) {
    const shown = await controlClient()
      .show(n)
      .catch(() => false);
    if (shown || !waitWindow || i >= WINDOW_WAIT) return shown;
    await wait(1000);
  }
}

// Remote desktop of one account. Every account has its browser window on the one desktop of the browsers
// container: the window of this account comes to the front, then the desktop opens. A light account whose window does
// not come gets an error, never the desktop with another account in front.
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await currentUser(req.headers);
  if (!user) return redirect(loginUrl(new URL(req.url).pathname));
  const { n, light } = await ownAccount(user.id, (await params).slot);
  // the desktop is still useful with the windows as they are
  if (!(await toFront(n, light)) && light) throw new HttpError(503, NOT_STARTED);
  return redirect("/desktop/");
});

// Another account to the front of the desktop already on screen (the switcher of /remote): no redirect, the desktop
// stays connected
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await currentUser(req.headers);
  if (!user) throw new HttpError(401, "Not signed in");
  const { n, light } = await ownAccount(user.id, (await params).slot);
  return Response.json({ ok: true, shown: await toFront(n, light) });
});
