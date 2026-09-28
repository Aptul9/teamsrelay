import { appDb, slotRow } from "@/lib/appdb";
import { queueOnce } from "@/lib/commands";
import { desktopUrlOf } from "@/lib/config";
import { body, HttpError, route } from "@/lib/http";
import { ON_ANOTHER_COMPUTER } from "@/lib/relay";
import { requireSlot } from "@/lib/session";
import { withSlot } from "@/lib/slotdb";
import { ringingCall } from "@/shared/slot-db/state";

// {since}: the call ringing now on the account, by when it started ringing. The agent clicks Accept with audio in
// Teams at its next look; the sound goes through the remote desktop of the account, which the app opens next.
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const { since } = await body(req);
  if (typeof since !== "number" || !Number.isSafeInteger(since) || since <= 0) throw new HttpError(400, "Missing call");
  if (slotRow(appDb(), slot)?.relay) throw new HttpError(409, ON_ANOTHER_COMPUTER);
  const ringing = withSlot(slot, (r) => ringingCall(r.call(), Date.now()));
  if (!ringing || ringing.since !== since) throw new HttpError(409, "Call no longer ringing");
  const id = queueOnce(slot, "answer", ringing.caller, JSON.stringify({ since }));
  return Response.json({ ok: true, id, desktop: desktopUrlOf(slot) });
});
