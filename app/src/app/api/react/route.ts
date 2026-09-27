import { chatName, queue, reactArgs } from "@/lib/commands";
import { body, route } from "@/lib/http";
import { requireSlot } from "@/lib/session";

// {emoji}: one of the six quick reactions. {pill}: the emoji of a reaction already under the message,
// clicked like in Teams (removed if it is yours, added otherwise).
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const b = await body(req);
  const name = chatName(b.name);
  return Response.json({ ok: true, id: queue(slot, "react", name, reactArgs(b.mid, b.emoji, b.pill)) });
});
