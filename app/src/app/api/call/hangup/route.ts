import { appDb, slotRow } from "@/lib/appdb";
import { queueOnce } from "@/lib/commands";
import { HttpError, route } from "@/lib/http";
import { ON_ANOTHER_COMPUTER } from "@/lib/relay";
import { requireSlot } from "@/lib/session";
import { withSlot } from "@/lib/slotdb";
import { inCallOf } from "@/shared/slot-db/state";

// The call in progress on the account: the agent presses the end-call shortcut of Teams web at its next look
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  if (slotRow(appDb(), slot)?.relay) throw new HttpError(409, ON_ANOTHER_COMPUTER);
  const call = withSlot(slot, (r) => inCallOf(r.inCall(), Date.now()));
  if (!call) throw new HttpError(409, "No call in progress");
  return Response.json({ ok: true, id: queueOnce(slot, "hangup", call.caller) });
});
