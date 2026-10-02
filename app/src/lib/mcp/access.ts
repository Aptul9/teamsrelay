import { bearerToken, sameToken } from "@/shared/bearer";
import { appDb } from "../appdb";
import { config } from "../config";
import { envAdminEmail } from "../env-admin";

// /mcp serves one person: the bearer of MCP_TOKEN acts as the administrator of .env.

// Why the web app must not start with this MCP_TOKEN; null when it may
export function mcpConfigError(): string | null {
  const token = config.mcpToken;
  if (!token) return null;
  if (token.length < 32) return "MCP_TOKEN must be at least 32 characters (openssl rand -hex 32), or empty to turn /mcp off";
  if (!envAdminEmail()) return "MCP_TOKEN needs ADMIN_EMAIL: /mcp reads the Teams accounts of that administrator";
  return null;
}

// Authorization: Bearer <MCP_TOKEN>
export function tokenMatches(authorization: string | null): boolean {
  const token = bearerToken(authorization);
  return !!config.mcpToken && !!token && sameToken(token, config.mcpToken);
}

// Id of the administrator of .env; null when there is none
export function mcpUserId(): string | null {
  const email = envAdminEmail();
  if (!email) return null;
  return (appDb().prepare('SELECT id FROM "user" WHERE lower(email)=?').pluck().get(email) as string | undefined) ?? null;
}
