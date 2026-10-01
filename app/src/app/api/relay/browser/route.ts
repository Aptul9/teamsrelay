import { route } from "@/lib/http";
import { requireRelay } from "@/lib/relay";

export const dynamic = "force-dynamic";

// Who may open the socket of the browser of a relay for the MCP clients (src/server/browser-hub.ts), asked by the hub
// with the Authorization header of the upgrade: the relay of an account on another computer, by its token
export const GET = route(async (req) => Response.json({ slot: requireRelay(req).slot }));
