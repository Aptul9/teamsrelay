import { chatName } from "@/lib/commands";
import { route } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import { withSlot } from "@/lib/slotdb";

export const GET = route(async (req) => {
  const { slot } = await requireSlot(req);
  const name = chatName(new URL(req.url).searchParams.get("name"));
  return Response.json(withSlot(slot, (r) => r.messages(name)));
});
