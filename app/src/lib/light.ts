import type { LightSignIn } from "@/shared/slot-db/state";
import { beginRefresh, endRefresh, listSlots, slotRow, type CheckResult, type Slot } from "./appdb";
import { SIGNED_OUT, type CheckDeps } from "./checks";
import { exclusive, slotUp } from "./slots";

// A light account runs its light agent (src/agent/light), no browser, on the sign-in its browser captured. That sign-in
// holds 24 h (a refresh token of a single-page app): once it ended, or Microsoft refused it, the browser runs again, one
// account at a time like the checks (src/lib/checks.ts), until Teams renewed the sign-in and the agent captured it
// (src/agent/jobs/light-token.ts), then the light agent takes over. The light agent renews its access tokens right
// before the end, so it keeps working the hour the browser run takes.

// Seconds a run waits for the new sign-in: Teams starting, then renewing its tokens
export const REFRESH_WAIT = 360;
// A sign-in that holds less than this many seconds is not the new one
export const MIN_LIFE = 600;
// A run is not tried again before this many seconds: after one that worked (a sign-in refused right away would start
// the browser again and again), and after one that did not
const AFTER_OK = 600;
const AFTER_FAILED = 1800;

const report = (n: number) => (e: Error) => console.error(`sign-in run of account ${n}: ${e.message}`);

// Whether the light account needs its browser now: no sign-in yet, one ended or about to, or one Microsoft refused
export function refreshDue(s: Slot, sign: LightSignIn | null, now: number): boolean {
  if (!s.light || s.stopped || s.relay || s.refreshing) return false;
  if (s.refreshed && now - s.refreshed < (s.refresh_result === "ok" ? AFTER_OK : AFTER_FAILED)) return false;
  if (!sign?.at || sign.refused) return true;
  return sign.expiresOn - now < 60;
}

const usable = (sign: LightSignIn | null, now: number) => !!sign?.at && !sign.refused && sign.expiresOn - now >= MIN_LIFE;

// The browser of the account until a sign-in it captured holds MIN_LIFE: ok; Teams signed out SIGNED_OUT seconds:
// login; nothing in REFRESH_WAIT: failed. The light agent runs again after it, whatever the outcome. null: the account
// was stopped, removed or set to another mode meanwhile, nothing recorded.
export async function runRefresh(n: number, d: CheckDeps): Promise<CheckResult | null> {
  const now = () => Math.floor((d.now ?? Date.now)() / 1000);
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const begun = now();
  const started = await exclusive(async () => {
    const s = slotRow(d.db, n);
    if (!s || s.stopped || !s.light) return false;
    beginRefresh(d.db, n, begun);
    try {
      await slotUp(d.ctl, n);
    } catch (e) {
      report(n)(e as Error);
      await d.ctl.light(n).catch(report(n));
      endRefresh(d.db, n, { now: now(), result: "failed" });
      return "failed" as const;
    }
    return true;
  });
  if (started !== true) return started || null;

  const current = () => {
    const s = slotRow(d.db, n);
    return !!s && !s.stopped && !!s.light;
  };
  let result: CheckResult | null = "failed";
  try {
    let signedOutSince = 0;
    for (;;) {
      if (!current()) {
        result = null;
        break;
      }
      if (usable(d.slot.lightSignIn(n), now())) {
        result = "ok";
        break;
      }
      const h = d.slot.health(n);
      if (h && h.ts >= begun && h.teams === "login") signedOutSince ||= now();
      else signedOutSince = 0;
      if (signedOutSince && now() - signedOutSince >= SIGNED_OUT) {
        result = "login";
        break;
      }
      if (now() - begun >= REFRESH_WAIT) break;
      await sleep(2000);
    }
  } finally {
    await exclusive(async () => {
      const s = slotRow(d.db, n);
      if (s && !s.stopped && s.light) await d.ctl.light(n).catch(report(n));
      if (s) endRefresh(d.db, n, { now: now(), result });
    });
  }
  return result;
}

// Every light account whose browser is due, one after the other
export async function runDueRefreshes(d: CheckDeps) {
  const now = Math.floor((d.now ?? Date.now)() / 1000);
  for (const s of listSlots(d.db)) {
    if (refreshDue(s, d.slot.lightSignIn(s.slot), now)) await runRefresh(s.slot, d);
  }
}
