import { appDb, slotOwner } from "@/lib/appdb";
import { config } from "@/lib/config";
import { HttpError, route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { renewRelayToken } from "@/lib/slots";

type Ctx = { params: Promise<{ slot: string }> };

// A new token for the relay of an account on another computer, shown this once; the previous token stops working.
// The owner only: whoever holds the token reads what the app sends to the account.
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const n = Number((await params).slot);
  if (!Number.isInteger(n) || slotOwner(appDb(), n) !== user.id) throw new HttpError(404, "Account not found");
  const token = await renewRelayToken(n, appDb());
  return Response.json({ ok: true, token, server: config.appUrl });
});
