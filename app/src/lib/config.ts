import path from "node:path";
import { parseEnv, PushEnv, pushSettings } from "@/shared/env";
import { DEFAULT_DESKTOP_URL } from "./client";

function positiveInt(name: string): number | null {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Read at call time, so tests and the standalone server see the environment they run with.
export const config = {
  get appDb() {
    return process.env.APP_DB || "/data/app.db";
  },
  get dataDir() {
    return path.dirname(config.appDb);
  },
  // Supervisor of the browsers container (see lib/control)
  get controlSocket() {
    return process.env.CONTROL_SOCKET || "/run/teamsrelay/control.sock";
  },
  // Accounts one user may add, null for no cap: the memory of the server is the only limit
  get accountsPerUser() {
    return positiveInt("ACCOUNTS_PER_USER");
  },
  // Remote desktop of a slot, {n} is the slot number. The default brings the window of the slot to the front
  // of the one desktop, then opens it.
  get desktopUrl() {
    return process.env.DESKTOP_URL || DEFAULT_DESKTOP_URL;
  },
  // The web app sends the notifications of the accounts on another computer itself (src/lib/relay.ts): the same
  // keys, subject, Firebase key and ntfy settings as the agents, checked the same way (boot stops on a wrong one)
  get push() {
    return pushSettings(parseEnv(PushEnv, process.env));
  },
  // Room of an account on another computer for its images and attachments on this server: RELAY_QUOTA_MB, 2048 by
  // default. Past it the server refuses its new files, and the app shows them missing.
  get relayQuotaBytes() {
    const mb = Number(process.env.RELAY_QUOTA_MB);
    return (Number.isFinite(mb) && mb > 0 ? mb : 2048) * 2 ** 20;
  },
  // Public URL of the app: APP_URL, otherwise https://DOMAIN (DOMAIN may already carry a scheme locally)
  get appUrl() {
    const explicit = process.env.APP_URL;
    if (explicit) return explicit.replace(/\/+$/, "");
    const domain = process.env.DOMAIN || "localhost:8090";
    return (/^https?:\/\//.test(domain) ? domain : `https://${domain}`).replace(/\/+$/, "");
  },
  // SESSION_SECRET is the variable of the previous release, accepted so an existing .env keeps working
  get authSecret() {
    return process.env.BETTER_AUTH_SECRET || process.env.SESSION_SECRET || "";
  },
  // Bearer token of the MCP endpoint (/mcp); empty turns the endpoint off
  get mcpToken() {
    return process.env.MCP_TOKEN || "";
  },
};

export function desktopUrlOf(slot: number): string {
  return config.desktopUrl.replace("{n}", String(slot));
}
