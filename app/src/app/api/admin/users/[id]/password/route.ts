import { auth } from "@/lib/auth";
import { body, HttpError, route, text } from "@/lib/http";
import { requireAdmin } from "@/lib/session";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/shared/password";

type Ctx = { params: Promise<{ id: string }> };

// New password set by an administrator; every device of the user has to sign in again
export const POST = route<Ctx>(async (req, { params }) => {
  await requireAdmin(req);
  const { id } = await params;
  const password = text((await body(req)).password, "password", PASSWORD_MAX);
  if (password.length < PASSWORD_MIN) throw new HttpError(400, `Password: at least ${PASSWORD_MIN} characters`);
  await auth().api.setUserPassword({ body: { userId: id, newPassword: password }, headers: req.headers });
  await auth().api.revokeUserSessions({ body: { userId: id }, headers: req.headers });
  return Response.json({ ok: true });
});
