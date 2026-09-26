import { route } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import { withSlot } from "@/lib/slotdb";

// History of the notifications sent for this account
export const GET = route(async (req) => {
  const { slot } = await requireSlot(req);
  return Response.json(withSlot(slot, (r) => r.feed()));
});
