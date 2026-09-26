import { appDb, slotOwner } from "@/lib/appdb";
import { controlClient } from "@/lib/control";
import { HttpError, route } from "@/lib/http";
import { currentUser } from "@/lib/session";

type Ctx = { params: Promise<{ slot: string }> };

const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location } });

// Remote desktop of one account. Every account has its browser window on the one desktop of the browsers
// container: the window of this account comes to the front, then the desktop opens.
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await currentUser(req.headers);
  if (!user) return redirect(`/login?next=${encodeURIComponent(new URL(req.url).pathname)}`);
  const n = Number((await params).slot);
  if (!Number.isInteger(n) || slotOwner(appDb(), n) !== user.id) throw new HttpError(404, "Account not found");
  // the desktop is still useful with the windows as they are
  await controlClient()
    .show(n)
    .catch(() => false);
  return redirect("/desktop/");
});
