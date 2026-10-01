import { requireMcpAuth } from "@better-auth/mcp";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { appDb } from "@/lib/appdb";
import { auth } from "@/lib/auth";
import { config } from "@/lib/config";
import { HttpError, route } from "@/lib/http";
import { mcpUserId, tokenMatches } from "@/lib/mcp/access";
import { consentGiven, jwksUrl, mcpResource } from "@/lib/mcp/oauth";
import { mcpServer } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";

// Created on first use, like the auth instance: the build imports route modules
let handler: McpHttpHandler | null = null;
const mcp = () =>
  (handler ??= createMcpHandler(({ authInfo }) => mcpServer(String(authInfo?.extra?.userId), { clientId: authInfo?.extra?.clientId as string | undefined }), {
    onerror: (e) => console.error("mcp:", e.message),
  }));

// A token that verified but no longer gives access: the user revoked the client, or the user is gone or banned
function revoked(resource: string): Response {
  const metadata = new URL("/.well-known/oauth-protected-resource" + new URL(resource).pathname, resource).toString();
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "This client no longer has access: sign in again" }, id: null },
    { status: 401, headers: { "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${metadata}"` } },
  );
}

let oauth: ((req: Request) => Promise<Response>) | null = null;
function oauthGuard(): ((req: Request) => Promise<Response>) | null {
  const resource = mcpResource();
  if (!resource) return null;
  return (oauth ??= requireMcpAuth(
    auth(),
    (req, claims) => {
      const userId = typeof claims.sub === "string" ? claims.sub : "";
      const clientId = typeof claims.client_id === "string" ? claims.client_id : typeof claims.azp === "string" ? claims.azp : "";
      const user = userId ? (appDb().prepare('SELECT banned FROM "user" WHERE id=?').get(userId) as { banned: number | null } | undefined) : undefined;
      if (!user || user.banned || !clientId || !consentGiven(userId, clientId)) return revoked(resource);
      return mcp().fetch(req, { authInfo: { token: "oauth", clientId, scopes: [], extra: { userId, clientId } } });
    },
    { resource, jwksUrl: jwksUrl() },
  ));
}

// MCP for AI clients (Streamable HTTP). Two kinds of bearer: MCP_TOKEN, which acts as the administrator of .env and gets
// the read tools only, and an OAuth access token of a user (@better-auth/mcp: sign-in of this app, consent, one token per
// client), which also gets the browsers of the relays of that user. No session cookie counts here, and a request from a
// web page (Origin) is refused.
export const POST = route(async (req) => {
  if (req.headers.has("origin")) throw new HttpError(403, "Requests from web pages are not accepted");
  if (config.mcpToken && tokenMatches(req.headers.get("authorization"))) {
    const userId = mcpUserId();
    if (!userId) throw new HttpError(503, "The administrator of .env does not exist");
    return mcp().fetch(req, { authInfo: { token: "MCP_TOKEN", clientId: "mcp-token", scopes: ["read"], extra: { userId } } });
  }
  const guard = oauthGuard();
  if (guard) return guard(req);
  if (!config.mcpToken) throw new HttpError(404, "Not found");
  throw new HttpError(401, "Missing or wrong token", { "WWW-Authenticate": 'Bearer realm="teamsrelay"' });
});
