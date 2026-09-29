import { appDb, slotRow } from "@/lib/appdb";
import { queueOnce } from "@/lib/commands";
import { body, HttpError, route } from "@/lib/http";
import { ON_ANOTHER_COMPUTER } from "@/lib/relay";
import { requireSlot } from "@/lib/session";
import { withSlot } from "@/lib/slotdb";
import { inCallOf } from "@/shared/slot-db/state";

// {on}: Teams' own mute of the call in progress on the account, muted (true) or not. The agent presses the mute
// shortcut of Teams web at its next look, only when Teams shows the other state.
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const { on } = await body(req);
  if (typeof on !== "boolean") throw new HttpError(400, "Missing mute state");
  if (slotRow(appDb(), slot)?.relay) throw new HttpError(409, ON_ANOTHER_COMPUTER);
  const call = withSlot(slot, (r) => inCallOf(r.inCall(), Date.now()));
  if (!call) throw new HttpError(409, "No call in progress");
  return Response.json({ ok: true, id: queueOnce(slot, "mute", call.caller, JSON.stringify({ on })) });
});
