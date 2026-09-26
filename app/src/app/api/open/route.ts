import { chatName, queue } from "@/lib/commands";
import { body, route } from "@/lib/http";
import { requireSlot } from "@/lib/session";

// Opens the chat in the remote Teams: the agent then keeps its messages up to date
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const b = await body(req);
  return Response.json({ ok: true, id: queue(slot, "open", chatName(b.name)) });
});
