import { healthFor } from "@/lib/accounts";
import { route } from "@/lib/http";
import { requireSlot } from "@/lib/session";

export const GET = route(async (req) => {
  const { user, slot } = await requireSlot(req);
  return Response.json(healthFor(user.id, slot));
});
