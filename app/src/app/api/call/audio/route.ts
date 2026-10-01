import { appDb, slotRow } from "@/lib/appdb";
import { config } from "@/lib/config";
import { HttpError, route } from "@/lib/http";
import { requireRelay } from "@/lib/relay";
import { requireSlot } from "@/lib/session";

export const dynamic = "force-dynamic";

// Who may open the socket of the sound of a call (src/server/call-audio-hub.ts), asked by the hub with the headers of
// the upgrade: the relay of an account on another computer by its token, or the page of the app of the owner of that
// account by its session, from the site of the app only (a websocket carries the cookie of any page that opens it)
export const GET = route(async (req) => {
  if (req.headers.has("authorization")) return Response.json({ slot: requireRelay(req).slot, side: "relay" });
  if (req.headers.get("origin") !== new URL(config.appUrl).origin) throw new HttpError(403, "Not from the app");
  const { slot } = await requireSlot(req);
  if (!slotRow(appDb(), slot)?.relay) throw new HttpError(409, "The sound of this account goes through its remote desktop");
  return Response.json({ slot, side: "app" });
});
