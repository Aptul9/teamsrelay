import { route } from "@/lib/http";
import { revokeClient } from "@/lib/mcp/oauth";
import { requireUser } from "@/lib/session";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

// Revoke: the client loses its access for this user at once (its tokens are refused from the next request)
export const DELETE = route<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  revokeClient(user.id, (await params).id);
  return Response.json({ ok: true });
});
