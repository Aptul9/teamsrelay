// Checks the two Firebase files of the Android app before they go live (docs/setup.md, Android app): the
// google-services.json of the repository secret GOOGLE_SERVICES_JSON and the service account key for
// fcm/service-account.json belong to one Firebase project, the app of the project is io.github.aptul9.teamsrelay, and
// the key may send FCM messages of that project (FCM validates a message to a made-up phone and delivers nothing). A
// file that is no service account key would stop the agents at their start. Prints ids and HTTP statuses, never a key.
//   node scripts/fcm-check.mjs <google-services.json> <service-account.json>
import fs from "node:fs";
import { JWT } from "google-auth-library";

const PACKAGE = "io.github.aptul9.teamsrelay";

const [gsPath, saPath] = process.argv.slice(2);
if (!gsPath || !saPath) {
  console.log("usage: node scripts/fcm-check.mjs <google-services.json> <service-account.json>");
  process.exit(2);
}
const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.log(`FAIL: ${file}: ${e.message}`);
    process.exit(1);
  }
};
const gs = read(gsPath);
const sa = read(saPath);

const project = gs?.project_info?.project_id;
const packages = (gs?.client ?? []).map((c) => c?.client_info?.android_client_info?.package_name).filter(Boolean);
console.log(`google-services.json: project ${project}, app ${packages.join(", ") || "none"}`);
console.log(`service account: ${sa?.client_email} of project ${sa?.project_id}`);
const problems = [];
if (!project) problems.push("the first file is no google-services.json (no project_info.project_id)");
else if (!packages.includes(PACKAGE)) problems.push(`google-services.json has no Android app ${PACKAGE}`);
if (sa?.type !== "service_account" || !sa.client_email || !sa.private_key) problems.push("the second file is no service account key");
else if (project && sa.project_id !== project) problems.push(`two Firebase projects, ${project} and ${sa.project_id}: the server would remove every phone (SENDER_ID_MISMATCH)`);
for (const p of problems) console.log(`FAIL: ${p}`);
if (problems.length) process.exit(1);

const auth = new JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  transporterOptions: { fetchImplementation: fetch },
});
let token;
try {
  ({ token } = await auth.getAccessToken());
} catch (e) {
  console.log(`FAIL: the key cannot sign in: ${e.message}`);
  process.exit(1);
}
const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ validate_only: true, message: { token: "fcm-check-000000000000000000000000000000", data: { v: "1" } } }),
});
const answer = await res.json().catch(() => ({}));
console.log(`FCM, message validated only, to a made-up phone: HTTP ${res.status} ${answer.error?.status ?? ""}`);
// the made-up phone comes back as an invalid token (400) once the key may send for the project; 401/403: role missing
// or the Firebase Cloud Messaging API off
if (res.status === 401 || res.status === 403) {
  console.log(`FAIL: ${answer.error?.message ?? "the key may not send FCM messages of this project"}`);
  process.exit(1);
}
console.log("OK: one project, the app of TeamsRelay, a key that sends");
