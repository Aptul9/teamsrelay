// The Firebase settings of the app (google-services.json, from the Firebase console) as the Android string resources
// the Firebase SDK reads when the app starts: google_app_id, gcm_defaultSenderId, google_api_key, project_id. The
// google-services Gradle plugin makes the same resources; written into the plugin, they need no change to the Android
// project Tauri generates. The file carries an API key: it stays out of git (mobile/.gitignore).
// Usage: node scripts/firebase-values.mjs <google-services.json> <values xml>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE = "io.github.aptul9.teamsrelay";

export function firebaseValues(json, pkg = PACKAGE) {
  const g = JSON.parse(json);
  const client = (g.client ?? []).find((c) => c.client_info?.android_client_info?.package_name === pkg);
  if (!client) throw new Error(`google-services.json has no Android app ${pkg}`);
  const values = {
    google_app_id: client.client_info.mobilesdk_app_id,
    gcm_defaultSenderId: g.project_info?.project_number,
    google_api_key: client.api_key?.[0]?.current_key,
    project_id: g.project_info?.project_id,
  };
  for (const [name, value] of Object.entries(values)) if (!value) throw new Error(`google-services.json lacks the value of ${name}`);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = Object.entries(values).map(([name, value]) => `    <string name="${name}" translatable="false">${esc(value)}</string>`);
  return `<?xml version="1.0" encoding="utf-8"?>\n<!-- made by mobile/scripts/firebase-values.mjs from google-services.json; not in git -->\n<resources>\n${lines.join("\n")}\n</resources>\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    console.error("usage: node scripts/firebase-values.mjs <google-services.json> <values xml>");
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, firebaseValues(fs.readFileSync(from, "utf8")));
  console.log(`Firebase values written to ${to}`);
}
