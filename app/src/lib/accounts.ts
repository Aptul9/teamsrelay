import { appDb, countPushSubscriptions, listSlots, slotsOf, type Slot } from "./appdb";
import { config, desktopUrlOf } from "./config";
import { HttpError } from "./http";
import { healthOf, SlotNotReady, withSlot, type Health } from "./slotdb";

export type AccountSummary = {
  slot: number;
  name: string;
  email: string;
  tenant: string;
  av: string;
  teams: string;
  overall: string;
  stopped: boolean;
  unread: number;
  // ids of the unread items of the Teams Activity feed, null until the agent reads it: the app counts the ones its
  // device has not shown yet
  unreadActivity: string[] | null;
  desktop: string;
};

// The grace for a browser still starting runs from the last start, not from the day the account was added
export const upSince = (s: Slot) => Math.max(s.added, s.started);

// A stopped account is grey, whatever its agent wrote before it stopped
export function slotHealth(h: Health, s: Slot): Health {
  return s.stopped ? { ...h, teams: "stopped", agent: "stopped", watcher: "stopped", overall: "grey" } : h;
}

export function accountSummary(s: Slot): AccountSummary {
  let me: { name?: string; email?: string; tenant?: string; av?: string } = {};
  let health: Health;
  let unread = 0;
  let unreadActivity: string[] | null = null;
  try {
    ({ me, health, unread, unreadActivity } = withSlot(s.slot, (r) => ({
      me: r.identity(),
      health: r.health(upSince(s)),
      unread: r.unreadCount(),
      unreadActivity: r.unreadActivity(),
    })));
  } catch (e) {
    if (!(e instanceof SlotNotReady)) throw e;
    health = healthOf({}, upSince(s));
  }
  health = slotHealth(health, s);
  return {
    slot: s.slot,
    name: me.name ?? "",
    email: me.email ?? "",
    tenant: me.tenant ?? "",
    av: me.av ?? "",
    teams: String(health.teams ?? ""),
    overall: String(health.overall ?? ""),
    stopped: !!s.stopped,
    unread,
    unreadActivity,
    desktop: desktopUrlOf(s.slot),
  };
}

export function accountsOf(userId: string) {
  const db = appDb();
  const taken = listSlots(db).length;
  return {
    accounts: slotsOf(db, userId).map(accountSummary),
    max: config.accountsPerUser,
    free: Math.max(0, config.slotCount - taken),
  };
}

export function healthFor(userId: string, slot: number): Health {
  const s = slotsOf(appDb(), userId).find((x) => x.slot === slot);
  if (!s) throw new HttpError(404, "Account not found");
  let h: Health;
  try {
    h = withSlot(slot, (r) => r.health(upSince(s)));
  } catch (e) {
    if (!(e instanceof SlotNotReady)) throw e;
    h = healthOf({}, upSince(s));
  }
  return { ...slotHealth(h, s), push_subs: countPushSubscriptions(appDb(), userId) };
}
