import { STATE, type AgentHealth } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { computeHealth, sessionExpired, type PageProbe } from "../logic/health";
import { isTeamsUrl } from "../logic/hosts";
import { errorText, log } from "../log";
import { probePage } from "../teams/scripts/page-state";
import { SEL, TEXTS } from "../teams/selectors";

// Health row read by the web app (healthOf in src/lib/slotdb.ts, the status panel), about every 5 s
export async function updateHealth(a: Agent): Promise<AgentHealth> {
  let probe: PageProbe | null = null;
  try {
    const url = a.tp.page.url();
    const onTeams = isTeamsUrl(url);
    probe = { url, ...(await a.tp.page.evaluate(probePage, { s: SEL, t: TEXTS, withPresence: onTeams })) };
    if (onTeams && probe.presence) {
      const before = a.store.getState(STATE.presencePrev);
      if (probe.presence !== before) {
        log.info("presence", `${before || "-"} to ${probe.presence}`);
        a.store.setState(STATE.presencePrev, probe.presence);
      }
    }
  } catch (e) {
    log.warn("health", errorText(e));
  }
  const h = computeHealth({
    probe,
    pushSubs: a.app.pushTargets().length,
    lastMsgTs: a.store.lastNotificationTs(),
    lastScanTs: Number(a.store.getState(STATE.lastScanTs)) || 0,
    now: nowSeconds(),
  });
  // one push when the session expires or Teams drops to reduced mode
  if (sessionExpired(h.teams, a.store.getState(STATE.teamsStatusPrev), !!a.store.getState(STATE.me))) {
    await a.notifier.push("TeamsRelay", "Teams session expired: open the remote desktop and sign in again to get messages back.");
  }
  a.store.setState(STATE.teamsStatusPrev, h.teams);
  a.store.setState(STATE.health, JSON.stringify(h));
  a.health = h;
  return h;
}

// Health while no Teams tab is visible (Teams reloading, or the browser still starting)
export function noTabHealth(a: Agent) {
  const h: AgentHealth = { cdp: "ok", teams: "loading", overall: "yellow", ts: nowSeconds() };
  a.store.setState(STATE.health, JSON.stringify(h));
  a.health = h;
}
