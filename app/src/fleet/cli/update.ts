// Updating a relay host to its checkout's current commit: pull, install deps (without the better-sqlite3 build - it
// ships prebuilt binaries, and without --ignore-scripts npm tries to compile it with Visual Studio on Windows),
// rebuild the relay bundle, restart it under pm2. Headless-safe; a Teams re-sign-in still needs the desktop window.
import type { FleetHost } from "./inventory";
import type { RunRequest } from "./client";

export const UPDATE_STEPS = ["git pull --ff-only", "npm ci --ignore-scripts", "npm run build:relay", "npx pm2 restart teamsrelay"] as const;

export function updateCommand(): string {
  return UPDATE_STEPS.join(" && ");
}

// npm ci then an esbuild build take longer than the cmdapi default: give the update its own deadline
const UPDATE_TIMEOUT = 900;

export function updateRequest(host: FleetHost): RunRequest {
  return { command: updateCommand(), cwd: host.appDir, timeout: UPDATE_TIMEOUT };
}
