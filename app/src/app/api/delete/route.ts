import { chatName, messageArgs, queue } from "@/lib/commands";
import { body, route } from "@/lib/http";
import { requireSlot } from "@/lib/session";

export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const b = await body(req);
  return Response.json({ ok: true, id: queue(slot, "delete", chatName(b.name), messageArgs(b.mid)) });
});
