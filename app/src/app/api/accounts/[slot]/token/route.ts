import { appDb } from "@/lib/appdb";
import { config } from "@/lib/config";
import { route } from "@/lib/http";
import { ownedSlot } from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { renewRelayToken } from "@/lib/slots";

type Ctx = { params: Promise<{ slot: string }> };

// A new token for the relay of an account on another computer, shown this once; the previous token stops working.
// The owner only: whoever holds the token reads what the app sends to the account.
export const POST = route<Ctx>(async (req, { params }) => {
  const { slot } = ownedSlot((await requireUser(req)).id, (await params).slot);
  const token = await renewRelayToken(slot, appDb());
  return Response.json({ ok: true, token, server: config.appUrl });
});
