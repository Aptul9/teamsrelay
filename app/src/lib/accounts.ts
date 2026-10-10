import { healthOf, STATE } from "@/shared/slot-db/state";
import { appDb, countPushSubscriptions, slotsOf, type Slot } from "./appdb";
import { config, desktopUrlOf } from "./config";
import { HttpError } from "./http";
import { withSlotOr, type Health } from "./slotdb";

export type AccountSummary = {
  slot: number;
  name: string;
  email: string;
  tenant: string;
  av: string;
  // the owner's own presence word (shared/presence), "" when unknown
  presence: string;
  teams: string;
  overall: string;
  stopped: boolean;
  unread: number;
  // ids of the unread items of the Teams Activity feed, null until the agent has saved the feed once: the app counts
  // the ones its device has not shown yet; missedCalls: the ids of every missed call of the feed (Teams shows them
  // as read, new or not), those its device has not shown yet count as missed
  unreadActivity: string[] | null;
  missedCalls: string[] | null;
  // ids of every item of the feed, newest first, null likewise
  activityIds: string[] | null;
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
  // an account on another computer: its relay joined this server; host: the name of that computer ("" before the
  // first sync), relaySeen: Unix seconds of its last sync
  relay: boolean;
  host: string;
  relaySeen: number;
  // its relay sends the sound of a call answered or placed from the app to the app (a relay of before does not)
  callAudio: boolean;
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
  const d = withSlotOr(
    s.slot,
    (r) => ({
      me: r.identity(),
      health: r.health(upSince(s)),
      unread: r.unreadCount(),
      unreadActivity: r.unreadActivity(),
      missedCalls: r.missedCalls(),
      activityIds: r.activityIds(),
      link: r.relayLink(),
      callAudio: r.state<unknown>(STATE.callAudio, 0) === 1,
      // the owner's own presence word, for the dot on their own avatar
      presence: r.state<string>(STATE.presence, ""),
    }),
    null,
  );
  const health = slotHealth(d?.health ?? healthOf({}, upSince(s)), s);
  const me = d?.me;
  return {
    slot: s.slot,
    name: me?.name ?? "",
    email: me?.email ?? "",
    tenant: me?.tenant ?? "",
    av: me?.av ?? "",
    presence: d?.presence ?? "",
    teams: String(health.teams ?? ""),
    overall: String(health.overall ?? ""),
    stopped: !!s.stopped,
    unread: d?.unread ?? 0,
    unreadActivity: d?.unreadActivity ?? null,
    missedCalls: d?.missedCalls ?? null,
    activityIds: d?.activityIds ?? null,
    added: s.added,
    // the Teams window of an account on another computer is there, not in the remote desktop
    desktop: s.relay ? "" : desktopUrlOf(s.slot),
    checkEvery: s.check_every,
    checked: s.checked,
    checkResult: s.check_result,
    nextCheck: s.check_due,
    checking: !!s.checking,
    relay: !!s.relay,
    host: d?.link.host ?? "",
    relaySeen: d?.link.seen ?? 0,
    callAudio: !!s.relay && !!d?.callAudio,
  };
}

export function accountsOf(userId: string) {
  return {
    accounts: slotsOf(appDb(), userId).map(accountSummary),
    max: config.accountsPerUser,
  };
}

export function healthFor(userId: string, slot: number): Health {
  const s = slotsOf(appDb(), userId).find((x) => x.slot === slot);
  if (!s) throw new HttpError(404, "Account not found");
  const h = withSlotOr(slot, (r) => r.health(upSince(s)), healthOf({}, upSince(s)));
  return { ...slotHealth(h, s), push_subs: countPushSubscriptions(appDb(), userId) };
}
