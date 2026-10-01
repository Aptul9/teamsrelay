import { appDb } from "../appdb";
import { config } from "../config";

// OAuth 2.1 for MCP clients (@better-auth/mcp, src/lib/auth.ts): what the web app adds around it. Access tokens are
// JWTs checked against the keys of the jwt plugin, valid until they expire whatever happens meanwhile: a client the user
// revoked is refused by its missing consent, read on every /mcp request.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The resource tokens are made for: /mcp of this app. null when the app is plain HTTP on a host other than this
// computer (better-auth refuses such a resource): OAuth is off then.
export function mcpResource(): string | null {
  let u: URL;
  try {
    u = new URL(`${config.appUrl}/mcp`);
  } catch {
    return null;
  }
  return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname)) ? u.toString() : null;
}

// The keys of the jwt plugin, read from the web app's own port: never through the public address (a server may not
// reach itself by its own name)
export const jwksUrl = () => `http://127.0.0.1:${process.env.PORT || "3000"}/api/auth/jwks`;

const loopbackRedirect = (u: unknown) => {
  if (typeof u !== "string") return false;
  try {
    const url = new URL(u);
    return url.protocol === "http:" && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
};

// The body of a registration with application_type "native" when it gives none and every redirect is plain HTTP on this
// computer (RFC 8252); the body as it came otherwise
export function nativeByDefault(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  const b = body as { application_type?: unknown; redirect_uris?: unknown };
  if (b.application_type !== undefined || !Array.isArray(b.redirect_uris) || !b.redirect_uris.length || !b.redirect_uris.every(loopbackRedirect)) return body;
  return { ...b, application_type: "native" };
}

// tables of the OAuth plugin, missing while OAuth is off
function tolerant<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && /no such table/.test(e.message)) return fallback;
    throw e;
  }
}

export function consentGiven(userId: string, clientId: string): boolean {
  return tolerant(() => !!appDb().prepare("SELECT 1 FROM oauthConsent WHERE userId=? AND clientId=?").get(userId, clientId), false);
}

// The clients a user allowed, newest first
export function clientsOf(userId: string): { clientId: string; name: string; since: string }[] {
  return tolerant(
    () =>
      appDb()
        .prepare(
          `SELECT k.clientId AS clientId, COALESCE(NULLIF(c.name, ''), k.clientId) AS name, MAX(k.createdAt) AS since
           FROM oauthConsent k LEFT JOIN oauthClient c ON c.clientId = k.clientId WHERE k.userId=? GROUP BY k.clientId ORDER BY since DESC`,
        )
        .all(userId) as { clientId: string; name: string; since: string }[],
    [],
  );
}

// The consent of the user for that client and every token it holds for the user: its access tokens are refused from now
// on, its refresh tokens give nothing more. The client can ask again, and gets in only through the sign-in and Allow.
export function revokeClient(userId: string, clientId: string) {
  tolerant(() => {
    const db = appDb();
    db.transaction(() => {
      for (const table of ["oauthConsent", "oauthRefreshToken", "oauthAccessToken"]) db.prepare(`DELETE FROM ${table} WHERE userId=? AND clientId=?`).run(userId, clientId);
    })();
  }, undefined);
}
