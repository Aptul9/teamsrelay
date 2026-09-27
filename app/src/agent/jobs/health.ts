import { STATE, Watch, parseState, type AgentHealth, type TeamsState } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { computeHealth, watchProblem, type PageProbe } from "../logic/health";
import { isTeamsUrl } from "../logic/hosts";
import { errorText, log } from "../log";
import { probePage } from "../teams/scripts/page-state";
import { SEL, TEXTS } from "../teams/selectors";

// Health row read by the app (healthOf in src/lib/slotdb.ts and the status panel; /api/state of the local relay),
// about every 5 s
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
    pushSubs: a.notifier.deviceCount(),
    lastMsgTs: a.store.lastNotificationTs(),
    lastScanTs: Number(a.store.getState(STATE.lastScanTs)) || 0,
    now: nowSeconds(),
  });
  return saveHealth(a, h);
}

// Health while the browser shows no Teams page. A blank tab: Teams is starting. Any other page: a sign-in waiting
// for someone (a federated sign-in page, a Microsoft page Teams sent the browser to).
export async function noTabHealth(a: Agent, url: string): Promise<AgentHealth> {
  const signIn = /^https?:/.test(url);
  return saveHealth(a, { cdp: "ok", teams: signIn ? "login" : "loading", overall: signIn ? "red" : "yellow", ts: nowSeconds() });
}

// Health while the browser does not start (local relay: the agent of a slot waits for its browser without a row)
export async function browserDownHealth(a: Agent): Promise<AgentHealth> {
  return saveHealth(a, { cdp: "ok", browser: "down", teams: "err", overall: "red", ts: nowSeconds() });
}

async function saveHealth(a: Agent, h: AgentHealth): Promise<AgentHealth> {
  await watchSignIn(a, h.teams);
  await watchBrowser(a, h.browser === "down");
  a.store.setState(STATE.teamsStatusPrev, h.teams);
  a.store.setState(STATE.health, JSON.stringify(h));
  a.health = h;
  return h;
}

// One push when Teams has been signed out for a minute (session expired, or Teams in reduced mode: nothing the agent
// can renew by itself), one more when it is back. Only for an account signed in once: before the first sign-in there
// is nothing to lose.
async function watchSignIn(a: Agent, teams: TeamsState) {
  const state = teams === "login" ? "problem" : teams === "ok" ? "fine" : "unknown";
  const w = parseState(Watch, a.store.getState(STATE.loginWatch), { since: 0, alerted: false });
  const { next, push } = watchProblem(state, w, { armed: !!a.store.getState(STATE.me), after: a.config.alerts.signInAfter, now: nowSeconds() });
  a.store.setState(STATE.loginWatch, JSON.stringify(next));
  if (push === "problem") {
    log.warn("SESSION", "Teams signed out: alert pushed");
    await a.notifier.alert("Teams signed out", `${a.config.alerts.signIn}: no messages until then.`);
  } else if (push === "fine") {
    log.info("SESSION", "Teams signed in again");
    await a.notifier.alert("Teams back", "Signed in again: messages are relayed.");
  }
}

// One push when the browser has not started for a few minutes, one more when it runs again
async function watchBrowser(a: Agent, down: boolean) {
  const w = parseState(Watch, a.store.getState(STATE.browserWatch), { since: 0, alerted: false });
  const { next, push } = watchProblem(down ? "problem" : "fine", w, { armed: true, after: a.config.alerts.browserAfter, now: nowSeconds() });
  a.store.setState(STATE.browserWatch, JSON.stringify(next));
  if (push === "problem") await a.notifier.alert("Relay browser down", `${a.config.alerts.browserDown}: see the log.`);
  else if (push === "fine") await a.notifier.alert("Relay browser back", "The browser runs again.");
}
