import { chatName, queue, textArgs } from "@/lib/commands";
import { body, route } from "@/lib/http";
import { requireSlot } from "@/lib/session";

// Reply with quote
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const b = await body(req);
  const args = textArgs(b.mid, b.text);
  return Response.json({ ok: true, id: queue(slot, "reply", chatName(b.name), args) });
});
