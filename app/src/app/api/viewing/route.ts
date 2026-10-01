import { chatName } from "@/lib/commands";
import { body, route } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import { withSlot } from "@/lib/slotdb";

// The chat on screen in the app ({chat}), marked while the app shows it, or the one it stopped showing ({left}): the
// agent holds a chat open in Teams, which reads what arrives there, only meanwhile (src/lib/viewing.ts). Also sent as
// a beacon while the page goes away.
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const b = await body(req);
  if (b.left !== undefined) {
    const chat = chatName(b.left);
    withSlot(slot, (r) => r.leaveViewing(chat));
  } else {
    const chat = chatName(b.chat);
    withSlot(slot, (r) => r.markViewing(chat));
  }
  return Response.json({ ok: true });
});
