import { auth } from "@/lib/auth";
import { route } from "@/lib/http";
import { requireAdmin } from "@/lib/session";

type Ctx = { params: Promise<{ id: string }> };

// Signs the user out of every device
export const DELETE = route<Ctx>(async (req, { params }) => {
  await requireAdmin(req);
  const { id } = await params;
  await auth().api.revokeUserSessions({ body: { userId: id }, headers: req.headers });
  return Response.json({ ok: true });
});
