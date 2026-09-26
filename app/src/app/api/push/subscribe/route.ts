import { appDb, savePushSubscription } from "@/lib/appdb";
import { body, route } from "@/lib/http";
import { requireUser } from "@/lib/session";

// A device receives the notifications of every account of its user, and of no one else's
export const POST = route(async (req) => {
  const user = await requireUser(req);
  savePushSubscription(appDb(), user.id, await body(req));
  return Response.json({ ok: true });
});
