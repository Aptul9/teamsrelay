import { queue } from "@/lib/commands";
import { route } from "@/lib/http";
import { requireSlot } from "@/lib/session";

// The agent switches Teams to the Activity view, reads it and goes back to the chat
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  return Response.json({ ok: true, id: queue(slot, "activity") });
});
