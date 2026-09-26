import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { config } from "@/lib/config";
import { HttpError, route } from "@/lib/http";
import { mcpUserId, tokenMatches } from "@/lib/mcp/access";
import { mcpServer } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";

// Created on first use, like the auth instance: the build imports route modules
let handler: McpHttpHandler | null = null;
const mcp = () =>
  (handler ??= createMcpHandler(({ authInfo }) => mcpServer(String(authInfo?.extra?.userId)), {
    onerror: (e) => console.error("mcp:", e.message),
  }));

// MCP for AI clients (Streamable HTTP), read only: the bearer of MCP_TOKEN acts as the administrator of .env.
// No session cookie counts here, and a request from a web page (Origin) is refused.
export const POST = route(async (req) => {
  if (!config.mcpToken) throw new HttpError(404, "Not found");
  if (req.headers.has("origin")) throw new HttpError(403, "Requests from web pages are not accepted");
  if (!tokenMatches(req.headers.get("authorization"))) {
    throw new HttpError(401, "Missing or wrong token", { "WWW-Authenticate": 'Bearer realm="teamsrelay"' });
  }
  const userId = mcpUserId();
  if (!userId) throw new HttpError(503, "The administrator of .env does not exist");
  return mcp().fetch(req, { authInfo: { token: "MCP_TOKEN", clientId: "mcp-token", scopes: ["read"], extra: { userId } } });
});
