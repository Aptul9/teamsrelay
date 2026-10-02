import { appDb, slotsOf } from "@/lib/appdb";
import { loginUrl, safeNext } from "@/lib/authz";
import { route } from "@/lib/http";
import { currentUser } from "@/lib/session";

// Caddy forward_auth for /desktop/: the one remote desktop shows the browser window of every account, live
// Teams sessions, so only users with a Teams account of the browsers container get through (an account on another
// computer has no window there). No session: back to the login, then to the desktop.
export const GET = route(async (req) => {
  const uri = req.headers.get("x-forwarded-uri") || "/";
  const user = await currentUser(req.headers);
  if (!user) {
    return new Response(null, { status: 302, headers: { Location: loginUrl(safeNext(uri)) } });
  }
  if (!slotsOf(appDb(), user.id).some((s) => !s.relay)) {
    return Response.json({ detail: "No Teams account on this user" }, { status: 403 });
  }
  return Response.json({ ok: true });
});
