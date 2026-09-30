import { queueOnce } from "@/lib/commands";
import { HttpError, route } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import { withSlot } from "@/lib/slotdb";
import { inCallOf } from "@/shared/slot-db/state";

// The call in progress on the account: the agent presses the end-call shortcut of Teams web at its next look
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const call = withSlot(slot, (r) => inCallOf(r.inCall(), Date.now()));
  if (!call) throw new HttpError(409, "No call in progress");
  return Response.json({ ok: true, id: queueOnce(slot, "hangup", call.caller) });
});
