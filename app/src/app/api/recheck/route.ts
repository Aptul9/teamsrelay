import { queue } from "@/lib/commands";
import { route } from "@/lib/http";
import { requireSlot } from "@/lib/session";

// Full check by the agent, outcome sent as a push notification
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  return Response.json({ ok: true, id: queue(slot, "recheck") });
});
