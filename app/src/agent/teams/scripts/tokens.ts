// Page script of the sign-in of Teams web. It runs inside the Teams page: self-contained, type imports only.

export type MsalEntry = { secret: string; clientId: string; homeAccountId: string; expiresOn: number };

// The MSAL entries Teams web keeps in localStorage whose key holds every one of `parts` (a credential type, a scope),
// with their secret. Teams web of some tenants keeps its cache encrypted (MSAL browser; AGAP2 on prod, 2026-11-03): the
// key in the cookie msal.cache.encryption ({id, key}, key the base64url of 32 bytes), each entry {id, nonce, data}:
// AES-GCM with a zero IV, its key derived by HKDF-SHA256 with the nonce as salt and the client id of the entry key as
// info. An entry of another key (id) is left out: MSAL drops it too.
export async function readMsalEntries(parts: string[]): Promise<MsalEntry[]> {
  const b64 = (s: string) => {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  };
  let cookie: { id?: string; key?: string } | null = null;
  const raw = document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("msal.cache.encryption="));
  if (raw) {
    try {
      cookie = JSON.parse(decodeURIComponent(raw.slice("msal.cache.encryption=".length)));
    } catch {
      cookie = null;
    }
  }
  let base: CryptoKey | null = null;
  const out: MsalEntry[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i) || "";
    const low = key.toLowerCase();
    if (!parts.every((p) => low.includes(p.toLowerCase()))) continue;
    let v: Record<string, unknown> | null = null;
    try {
      v = JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      continue;
    }
    if (!v || typeof v !== "object") continue;
    if (typeof v.data === "string" && typeof v.nonce === "string") {
      if (!cookie?.key || v.id !== cookie.id) continue;
      try {
        base ??= await crypto.subtle.importKey("raw", b64(cookie.key), "HKDF", false, ["deriveKey"]);
        // the client id of the key: the first id after the account (home account id, two ids joined by a dot)
        const context = key.split("|").slice(2).find((p) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p)) || "";
        const derived = await crypto.subtle.deriveKey({ name: "HKDF", salt: b64(v.nonce), hash: "SHA-256", info: new TextEncoder().encode(context) }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
        v = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, derived, b64(v.data))));
      } catch {
        continue;
      }
      if (!v || typeof v !== "object") continue;
    }
    if (typeof v.secret !== "string" || !v.secret) continue;
    out.push({ secret: v.secret, clientId: String(v.clientId || ""), homeAccountId: String(v.homeAccountId || ""), expiresOn: Number(v.expiresOn) || 0 });
  }
  return out;
}
