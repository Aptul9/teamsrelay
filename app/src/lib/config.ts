import path from "node:path";

function positiveInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Read at call time, so tests and the standalone server see the environment they run with.
export const config = {
  get appDb() {
    return process.env.APP_DB || "/data/app.db";
  },
  get dataDir() {
    return path.dirname(config.appDb);
  },
  // Wipe requests for the teams-wipe-N containers (see wipeSlot)
  get wipeDir() {
    return process.env.WIPE_DIR || "/wipe";
  },
  get dockerApi() {
    return process.env.DOCKER_API || "";
  },
  get slotCount() {
    return positiveInt("SLOT_COUNT", 4);
  },
  get accountsPerUser() {
    return positiveInt("ACCOUNTS_PER_USER", config.slotCount);
  },
  // Remote desktop of a slot, {n} is the slot number
  get desktopUrl() {
    return process.env.DESKTOP_URL || "/desktop/{n}/";
  },
  get vapidAppKeyFile() {
    return process.env.VAPID_APPKEY || "/vapid/appkey.txt";
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
