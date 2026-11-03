// Page script of the sign-in of Teams web. It runs inside the Teams page: self-contained, type imports only.

export type PageRefreshToken = { secret: string; clientId: string; homeAccountId: string; expiresOn: number };

// The MSAL refresh token of Teams web (the client `clientId`), else the first one the page keeps; null when none
export function readRefreshToken(clientId: string): PageRefreshToken | null {
  let first: PageRefreshToken | null = null;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i) || "";
    if (!key.toLowerCase().includes("refreshtoken")) continue;
    let v: { secret?: unknown; clientId?: unknown; homeAccountId?: unknown; expiresOn?: unknown } | null = null;
    try {
      v = JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      continue;
    }
    if (!v || typeof v.secret !== "string" || !v.secret) continue;
    const entry = { secret: v.secret, clientId: String(v.clientId || ""), homeAccountId: String(v.homeAccountId || ""), expiresOn: Number(v.expiresOn) || 0 };
    if (entry.clientId === clientId) return entry;
    if (!first) first = entry;
  }
  return first;
}
