import { route } from "@/lib/http";
import { declaredLength, requireRelay, saveRelayFile } from "@/lib/relay";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ file: string }> };

// An image or profile picture of the account on another computer, into data/N/media
export const PUT = route<Ctx>(async (req, { params }) => {
  const caller = requireRelay(req);
  await saveRelayFile(caller, "media", (await params).file, req.body, declaredLength(req));
  return Response.json({ ok: true });
});
