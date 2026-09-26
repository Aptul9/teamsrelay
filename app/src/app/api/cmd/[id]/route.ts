import { HttpError, route } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import { withSlot } from "@/lib/slotdb";

type Ctx = { params: Promise<{ id: string }> };

// Outcome of a queued command: pending, done (Teams showed the change) or failed
export const GET = route<Ctx>(async (req, { params }) => {
  const { slot } = await requireSlot(req);
  const id = Number((await params).id);
  if (!Number.isInteger(id)) throw new HttpError(404, "Command not found");
  const status = withSlot(slot, (r) => r.commandStatus(id));
  if (!status) throw new HttpError(404, "Command not found");
  return Response.json(status);
});
