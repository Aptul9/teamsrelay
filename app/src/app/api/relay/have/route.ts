import { route } from "@/lib/http";
import { missingRelayFiles, relayJson, requireRelay } from "@/lib/relay";
import { HaveBody } from "@/shared/relay-sync";

export const dynamic = "force-dynamic";

// Of the images and attachments the relay has, the ones this server lacks: the relay uploads those
export const POST = route(async (req) => {
  const { slot } = requireRelay(req);
  return Response.json(missingRelayFiles(slot, await relayJson(req, HaveBody, 4e6)));
});
