import { appDb, countPushSubscriptions, listSlots, slotsOf, type Slot } from "./appdb";
import { config, desktopUrlOf } from "./config";
import { healthOf, SlotNotReady, withSlot, type Health } from "./slotdb";

export type AccountSummary = {
  slot: number;
  name: string;
  email: string;
  tenant: string;
  av: string;
  teams: string;
  overall: string;
  unread: number;
  desktop: string;
};

export function accountSummary(s: Slot): AccountSummary {
  let me: { name?: string; email?: string; tenant?: string; av?: string } = {};
  let health: Health;
  let unread = 0;
  try {
    ({ me, health, unread } = withSlot(s.slot, (r) => ({ me: r.identity(), health: r.health(s.added), unread: r.unreadCount() })));
  } catch (e) {
    if (!(e instanceof SlotNotReady)) throw e;
    health = healthOf({}, s.added);
  }
  return {
    slot: s.slot,
    name: me.name ?? "",
    email: me.email ?? "",
    tenant: me.tenant ?? "",
    av: me.av ?? "",
    teams: String(health.teams ?? ""),
    overall: String(health.overall ?? ""),
    unread,
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

export function healthFor(userId: string, slot: number, added: number): Health {
  let h: Health;
  try {
    h = withSlot(slot, (r) => r.health(added));
  } catch (e) {
    if (!(e instanceof SlotNotReady)) throw e;
    h = healthOf({}, added);
  }
  return { ...h, push_subs: countPushSubscriptions(appDb(), userId) };
}
