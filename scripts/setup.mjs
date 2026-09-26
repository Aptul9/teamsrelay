// First run of the relay: push keys, API token and .env. What exists is kept: new push keys make every phone enable
// notifications again, a new token signs every phone out. Run again to see the token.
//   npm run setup
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

if (!fs.existsSync(".env")) {
  fs.copyFileSync(".env.example", ".env");
  console.log(".env written from .env.example");
}
process.loadEnvFile(".env");
const state = path.resolve(process.env.STATE_DIR || "state");
fs.mkdirSync(state, { recursive: true });

const vapid = path.join(state, "vapid");
if (fs.existsSync(path.join(vapid, "private_key.pem"))) console.log(`push keys: kept in ${vapid}`);
else execFileSync(process.execPath, [path.join(import.meta.dirname, "gen-vapid.mjs"), vapid], { stdio: "inherit" });

const tokenFile = path.join(state, "token");
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, `${randomBytes(24).toString("base64url")}\n`, { mode: 0o600 });
console.log(`API token (type it once in the app on the phone): ${fs.readFileSync(tokenFile, "utf8").trim()}`);
