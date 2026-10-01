import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Discovery of OAuth for MCP clients (@better-auth/mcp), outside /api/auth: /.well-known/oauth-protected-resource/mcp
// names /mcp and its authorization server, /.well-known/oauth-authorization-server/api/auth the endpoints of that server
// (its issuer carries the path /api/auth). better-auth answers them, and 404 for the rest.
export const GET = (req: Request) => auth().handler(req);
