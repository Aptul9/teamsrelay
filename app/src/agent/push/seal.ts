import crypto from "node:crypto";

// What the relay sends a phone of the Android app (mobile/) is sealed with the key of that phone, AES-256-GCM, so that
// Google carries ciphertext only, as with Web Push; the app opens it (mobile/plugin/android Seal.kt). Apart from the
// sender (fcm.ts), which brings Google's auth client: what only seals, the local relay included, goes without it.

// The key of a phone: 32 random bytes, base64url, answered to each registration of the phone
export const newDeviceKey = () => crypto.randomBytes(32).toString("base64url");

// The data of the FCM message for `content`: v 1, iv (12 random bytes), ct (ciphertext and 16-byte tag), base64url
export function sealFor(key: string, content: object): Record<string, string> {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(content), "utf8"), c.final(), c.getAuthTag()]);
  return { v: "1", iv: iv.toString("base64url"), ct: ct.toString("base64url") };
}
