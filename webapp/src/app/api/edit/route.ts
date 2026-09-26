import { chatName, messageId, messageText, queue } from "@/lib/commands";
import { body, route } from "@/lib/http";
import { requireSlot } from "@/lib/session";

// Own messages only: Teams shows the edit button on those alone
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const b = await body(req);
  const args = JSON.stringify({ mid: messageId(b.mid), text: messageText(b.text) });
  return Response.json({ ok: true, id: queue(slot, "edit", chatName(b.name), args) });
});
