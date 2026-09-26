// First run of the local relay: push keys, API token and relay.env. What exists is kept: new push keys make every
// phone enable notifications again, a new token signs every phone out. Run again to see the token.
//   npm run relay:setup
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

if (!fs.existsSync("relay.env")) {
  fs.copyFileSync("relay.env.example", "relay.env");
  console.log("relay.env written from relay.env.example");
}
process.loadEnvFile("relay.env");
const state = path.resolve(process.env.STATE_DIR || "state");
fs.mkdirSync(state, { recursive: true });

const vapid = path.join(state, "vapid");
if (fs.existsSync(path.join(vapid, "private_key.pem"))) console.log(`push keys: kept in ${vapid}`);
else execFileSync(process.execPath, [path.join(import.meta.dirname, "gen-vapid.mjs"), vapid], { stdio: "inherit" });

const tokenFile = path.join(state, "token");
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, `${randomBytes(24).toString("base64url")}\n`, { mode: 0o600 });
console.log(`API token (type it once in the app on the phone): ${fs.readFileSync(tokenFile, "utf8").trim()}`);
