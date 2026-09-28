import { route } from "@/lib/http";
import { relayJson, relayPush, requireRelay } from "@/lib/relay";
import { PushBody } from "@/shared/relay-sync";

export const dynamic = "force-dynamic";

// A notification of the account on another computer, sent from here to the devices of its owner
export const POST = route(async (req) => {
  const caller = requireRelay(req);
  const sent = await relayPush(caller, await relayJson(req, PushBody, 1e6));
  return Response.json({ ok: true, sent });
});
