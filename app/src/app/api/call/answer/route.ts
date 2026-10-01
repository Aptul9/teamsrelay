import { appDb, slotRow } from "@/lib/appdb";
import { queueOnce } from "@/lib/commands";
import { desktopUrlOf } from "@/lib/config";
import { body, HttpError, route } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import { withSlot } from "@/lib/slotdb";
import { ringingCall } from "@/shared/slot-db/state";

// {since}: the call ringing now on the account, by when it started ringing. The agent clicks Accept with audio in
// Teams at its next look; the sound goes through the remote desktop of the account, which the app opens next. An
// account on another computer has none: its relay takes the command and its agent clicks in the Teams window there,
// where the sound stays.
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const { since, audio } = await body(req);
  if (typeof since !== "number" || !Number.isSafeInteger(since) || since <= 0) throw new HttpError(400, "Missing call");
  const ringing = withSlot(slot, (r) => ringingCall(r.call(), Date.now()));
  if (!ringing || ringing.since !== since) throw new HttpError(409, "Call no longer ringing");
  const relay = !!slotRow(appDb(), slot)?.relay;
  // audio: the page opened the sound of the call; the relay of an account on another computer then sends it there
  const id = queueOnce(slot, "answer", ringing.caller, JSON.stringify({ since, ...(relay && audio === true ? { audio: true } : {}) }));
  return Response.json({ ok: true, id, desktop: relay ? null : desktopUrlOf(slot) });
});
