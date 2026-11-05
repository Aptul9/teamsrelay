import { appDb, askCheck, askRefresh, slotRow } from "@/lib/appdb";
import { HttpError, route } from "@/lib/http";
import { requireAccount } from "@/lib/session";

type Ctx = { params: Promise<{ slot: string }> };

// "Check now" for an account checked every N hours: its check is due at once. The checks of the web app
// (src/lib/checks.ts) run it within seconds, after the check running now, if any. For a light account, whose browser
// runs only to sign it in again: that browser run, waiting for the sign-in in the remote desktop (src/lib/light.ts).
export const POST = route<Ctx>(async (req, { params }) => {
  const n = await requireAccount(req, (await params).slot);
  const s = slotRow(appDb(), n);
  if (s?.stopped) throw new HttpError(409, "This Teams account is stopped: start it from its page or from Settings");
  if (s?.light) {
    askRefresh(appDb(), n);
    return Response.json({ ok: true });
  }
  if (!s?.check_every) throw new HttpError(409, "This Teams account is always on: there is nothing to check");
  askCheck(appDb(), n);
  return Response.json({ ok: true });
});
