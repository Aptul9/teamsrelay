import { chatName, messageId, queue, REACTIONS } from "@/lib/commands";
import { body, HttpError, route } from "@/lib/http";
import { requireSlot } from "@/lib/session";

// {emoji}: one of the six quick reactions. {pill}: the emoji of a reaction already under the message,
// clicked like in Teams (removed if it is yours, added otherwise).
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const b = await body(req);
  const name = chatName(b.name);
  const mid = messageId(b.mid);
  if (b.pill) {
    if (typeof b.pill !== "string" || b.pill.length > 16) throw new HttpError(400, "Invalid reaction");
    return Response.json({ ok: true, id: queue(slot, "react", name, JSON.stringify({ mid, pill: b.pill })) });
  }
  if (typeof b.emoji !== "string" || !REACTIONS.has(b.emoji)) throw new HttpError(400, "Unsupported reaction");
  return Response.json({ ok: true, id: queue(slot, "react", name, JSON.stringify({ mid, emoji: b.emoji })) });
});
