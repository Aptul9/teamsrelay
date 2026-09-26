import { appDb, deletePushSubscriptionsOf, slotsOf } from "@/lib/appdb";
import { auth } from "@/lib/auth";
import { config } from "@/lib/config";
import { controlClient } from "@/lib/control";
import { HttpError, route } from "@/lib/http";
import { requireAdmin } from "@/lib/session";
import { removeAccount } from "@/lib/slots";

type Ctx = { params: Promise<{ id: string }> };

// Deleting a user signs their Teams accounts out first: slots stopped and wiped, devices forgotten.
export const DELETE = route<Ctx>(async (req, { params }) => {
  const admin = await requireAdmin(req);
  const { id } = await params;
  if (id === admin.id) throw new HttpError(400, "You cannot delete yourself");
  const db = appDb();
  for (const { slot } of slotsOf(db, id)) {
    await removeAccount(slot, controlClient(), { db, dataDir: config.dataDir });
  }
  deletePushSubscriptionsOf(db, id);
  await auth().api.removeUser({ body: { userId: id }, headers: req.headers });
  return Response.json({ ok: true });
});
