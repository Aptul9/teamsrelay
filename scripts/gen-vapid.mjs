// Web Push keys of TeamsRelay (VAPID), generated once:
//   <dir>/private_key.pem  private key (PKCS#8 PEM, P-256): the agents sign the pushes with it. Never commit it.
//   <dir>/appkey.txt       public key (applicationServerKey, base64url) the web app hands to the browsers
// New keys make every device enable notifications again, so an existing private_key.pem is never replaced.
//   node app/scripts/gen-vapid.mjs vapid
//   docker run --rm -v "$PWD:/w" -w /w node:24-slim node app/scripts/gen-vapid.mjs vapid
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] || "vapid";
const pem = path.join(dir, "private_key.pem");
if (fs.existsSync(pem)) {
  console.error(`${pem} exists, not replaced: the devices subscribed with its public key would stop receiving notifications`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
fs.writeFileSync(pem, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
const { x, y } = publicKey.export({ format: "jwk" });
const appKey = Buffer.concat([Buffer.from([4]), Buffer.from(x, "base64url"), Buffer.from(y, "base64url")]).toString("base64url");
fs.writeFileSync(path.join(dir, "appkey.txt"), appKey);
console.log(`VAPID keys written to ${dir}`);
console.log(`applicationServerKey: ${appKey}`);
