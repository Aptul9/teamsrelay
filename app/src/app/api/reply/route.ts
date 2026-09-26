import { chatName, messageId, messageText, queue } from "@/lib/commands";
import { body, route } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import type { TextArgs } from "@/shared/slot-db/commands";

// Reply with quote
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const b = await body(req);
  const args = JSON.stringify({ mid: messageId(b.mid), text: messageText(b.text) } satisfies TextArgs);
  return Response.json({ ok: true, id: queue(slot, "reply", chatName(b.name), args) });
});
