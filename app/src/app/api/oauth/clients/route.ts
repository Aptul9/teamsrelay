import { route } from "@/lib/http";
import { clientsOf } from "@/lib/mcp/oauth";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

// The MCP clients the user allowed (OAuth), newest first
export const GET = route(async (req) => Response.json({ clients: clientsOf((await requireUser(req)).id) }));
