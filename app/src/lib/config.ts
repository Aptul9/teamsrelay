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
  // Supervisor of the browsers container (see lib/control)
  get controlSocket() {
    return process.env.CONTROL_SOCKET || "/run/teamsrelay/control.sock";
  },
  get slotCount() {
    return positiveInt("SLOT_COUNT", 4);
  },
  get accountsPerUser() {
    return positiveInt("ACCOUNTS_PER_USER", config.slotCount);
  },
  // Remote desktop of a slot, {n} is the slot number. The default brings the window of the slot to the front
  // of the one desktop, then opens it.
  get desktopUrl() {
    return process.env.DESKTOP_URL || "/api/desktop/{n}";
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
};

export function desktopUrlOf(slot: number): string {
  return config.desktopUrl.replace("{n}", String(slot));
}
