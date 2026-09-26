import { createPrivateKey } from "node:crypto";
import fs from "node:fs";
import { ConfigError } from "@/relay/config";

export type VapidKeys = { publicKey: string; privateKey: string };

// The Web Push keys of state/vapid: private_key.pem (PKCS#8, P-256, written by scripts/gen-vapid.mjs, or copied
// from a teamsrelay server) and appkey.txt, the public key the devices subscribed with. web-push takes the raw
// private scalar and the uncompressed public point, both base64url.
export function vapidKeysFromPem(pem: string): VapidKeys {
  const jwk = createPrivateKey(pem).export({ format: "jwk" });
  if (jwk.crv !== "P-256" || !jwk.d || !jwk.x || !jwk.y) throw new ConfigError("VAPID private key is not a P-256 key");
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return { publicKey: point.toString("base64url"), privateKey: jwk.d };
}

// null without a private key: push stays off and the relay runs. A key that does not match appkey.txt would
// sign pushes every subscribed device rejects: the relay stops at start.
export function loadVapidKeys(privateKeyFile: string, appKeyFile: string): VapidKeys | null {
  if (!fs.existsSync(privateKeyFile)) return null;
  const keys = vapidKeysFromPem(fs.readFileSync(privateKeyFile, "utf8"));
  if (fs.existsSync(appKeyFile)) {
    const appKey = fs.readFileSync(appKeyFile, "utf8").trim();
    if (appKey !== keys.publicKey) throw new ConfigError(`${privateKeyFile} does not match the public key in ${appKeyFile}`);
  }
  return keys;
}
