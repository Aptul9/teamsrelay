import { route } from "@/lib/http";
import { applySync, relayJson, requireRelay } from "@/lib/relay";
import { SyncBody } from "@/shared/relay-sync";

export const dynamic = "force-dynamic";

// The relay of an account on another computer: what changed in its relay.db since its last sync, into the database of
// the slot
export const POST = route(async (req) => {
  const { slot } = requireRelay(req);
  applySync(slot, await relayJson(req, SyncBody));
  return Response.json({ ok: true });
});
