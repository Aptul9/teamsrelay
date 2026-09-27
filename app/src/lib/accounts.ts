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
  // ids of the unread items of the Teams Activity feed, null until the agent has saved the feed once: the app counts
  // the ones its device has not shown yet; unreadCalls: those that are missed calls
  unreadActivity: string[] | null;
  unreadCalls: string[] | null;
  // Unix seconds the account took its slot: a slot freed and taken by another account gets a new value
  added: number;
  desktop: string;
  // seconds between two checks, 0 for an account always on; end and outcome (ok, login, failed) of the last check, 0
  // and "" before the first; when the next one is due, 0 once asked from the app; a check running now
  checkEvery: number;
  checked: number;
  checkResult: string;
  nextCheck: number;
  checking: boolean;
};

// The grace for a browser still starting runs from the last start, not from the day the account was added: a start
// from the app or the start of a check
export const upSince = (s: Slot) => Math.max(s.added, s.started, s.checking);

// A stopped account is grey, whatever its agent wrote before it stopped; so is an account checked every N hours
// between two checks, whose browser does not run
export function slotHealth(h: Health, s: Slot): Health {
  if (s.stopped) return { ...h, teams: "stopped", agent: "stopped", watcher: "stopped", overall: "grey" };
  if (s.check_every && !s.checking) return { ...h, teams: "checked", agent: "stopped", watcher: "stopped", overall: "grey" };
  return h;
}

export function accountSummary(s: Slot): AccountSummary {
  let me: { name?: string; email?: string; tenant?: string; av?: string } = {};
  let health: Health;
  let unread = 0;
  let unreadActivity: string[] | null = null;
  let unreadCalls: string[] | null = null;
  try {
    ({ me, health, unread, unreadActivity, unreadCalls } = withSlot(s.slot, (r) => ({
      me: r.identity(),
      health: r.health(upSince(s)),
      unread: r.unreadCount(),
      unreadActivity: r.unreadActivity(),
      unreadCalls: r.unreadCalls(),
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
    unreadCalls,
    added: s.added,
    desktop: desktopUrlOf(s.slot),
    checkEvery: s.check_every,
    checked: s.checked,
    checkResult: s.check_result,
    nextCheck: s.check_due,
    checking: !!s.checking,
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
