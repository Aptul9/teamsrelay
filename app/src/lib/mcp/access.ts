import { createHash, timingSafeEqual } from "node:crypto";
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

const digest = (s: string) => createHash("sha256").update(s).digest();

// Authorization: Bearer <MCP_TOKEN>. Digests have one length, so the comparison takes the same time for any value.
export function tokenMatches(authorization: string | null): boolean {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  return !!config.mcpToken && !!m && timingSafeEqual(digest(m[1]), digest(config.mcpToken));
}

// Id of the administrator of .env; null when there is none
export function mcpUserId(): string | null {
  const email = envAdminEmail();
  if (!email) return null;
  return (appDb().prepare('SELECT id FROM "user" WHERE lower(email)=?').pluck().get(email) as string | undefined) ?? null;
}
