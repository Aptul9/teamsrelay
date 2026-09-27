import { route } from "@/lib/http";
import { requireRelay, saveRelayFile } from "@/lib/relay";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ file: string }> };

// An attachment the relay downloaded for the app, into data/N/files
export const PUT = route<Ctx>(async (req, { params }) => {
  const caller = requireRelay(req);
  await saveRelayFile(caller, "files", (await params).file, req.body);
  return Response.json({ ok: true });
});
