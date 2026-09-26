import { route } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import { withSlot } from "@/lib/slotdb";

export const GET = route(async (req) => {
  const { slot } = await requireSlot(req);
  return Response.json(withSlot(slot, (r) => r.chats()));
});
