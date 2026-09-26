import { appDb, slotOwner } from "@/lib/appdb";
import { desktopSlot, safeNext } from "@/lib/authz";
import { route } from "@/lib/http";
import { currentUser } from "@/lib/session";

// Caddy forward_auth for /desktop/N/: the remote browser of slot N is the live Teams session of its
// owner, so only the owner gets through. No session: back to the login, then to the desktop.
export const GET = route(async (req) => {
  const uri = req.headers.get("x-forwarded-uri") || "/";
  const user = await currentUser(req.headers);
  if (!user) {
    return new Response(null, { status: 302, headers: { Location: `/login?next=${encodeURIComponent(safeNext(uri))}` } });
  }
  const n = desktopSlot(uri);
  if (n === null || slotOwner(appDb(), n) !== user.id) {
    return Response.json({ detail: "This desktop belongs to another account" }, { status: 403 });
  }
  return Response.json({ ok: true });
});
