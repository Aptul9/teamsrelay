import { presenceOf } from "@/shared/presence";
import { SIGN_IN_TRY_WAIT } from "@/shared/sign-in";
import { SignInTry, STATE, Watch, parseState, type AgentHealth, type TeamsState } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { computeHealth, watchProblem, type PageProbe } from "../logic/health";
import { isTeamsUrl } from "../logic/hosts";
import { errorText, log } from "../log";
import { openOverlayNames } from "../teams/scripts/message-actions";
import { probePage, uncoveredPoint } from "../teams/scripts/page-state";
import { SEL, TEXTS } from "../teams/selectors";
import { ownerUses } from "./page-setup";

// seconds Teams stays signed out, or the browser does not start, before the push (config.alerts may say otherwise)
const SIGN_IN_AFTER = 60;
const BROWSER_AFTER = 300;

// Health row read by the app (healthOf in src/shared/slot-db/state.ts and the status panel; /api/state of the local relay),
// about every 5 s
export async function updateHealth(a: Agent): Promise<AgentHealth> {
  let probe: PageProbe | null = null;
  let rail = false;
  try {
    const url = a.tp.page.url();
    const onTeams = isTeamsUrl(url);
    probe = { url, ...(await a.tp.page.evaluate(probePage, { s: SEL, t: TEXTS, withPresence: onTeams })) };
    // a menu or dialog over the side bar does not count: the Activity job closes those first
    if (onTeams && a.config.activity) {
      rail = !!(await a.tp.page.evaluate(uncoveredPoint, SEL.activityView)) || (await a.tp.page.evaluate(openOverlayNames, SEL)).length > 0;
    }
    if (onTeams && probe.presence) {
      // the owner's own presence, mapped to a Presence word, for the dot on their own avatar in the app
      a.store.setState(STATE.presence, presenceOf(probe.presence));
      const before = a.store.getState(STATE.presencePrev);
      if (probe.presence !== before) {
        log.info("presence", `${before || "-"} to ${probe.presence}`);
        a.store.setState(STATE.presencePrev, probe.presence);
      }
    }
  } catch (e) {
    log.warn("health", errorText(e));
  }
  a.railReady = rail;
  const h = computeHealth({
    probe,
    pushSubs: a.notifier.deviceCount(),
    lastMsgTs: a.store.lastNotificationTs(),
    lastScanTs: Number(a.store.getState(STATE.lastScanTs)) || 0,
    now: nowSeconds(),
  });
  // the side bar without the chat list: since when (backToChats in the loop); the list back ends the tries
  if (h.teams === "loading" && rail) a.loadingSince ??= Date.now();
  else a.loadingSince = undefined;
  if (h.teams === "ok") a.backTries = 0;
  if (ownerUses(a)) h.desktop = "in-use";
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
// is nothing to lose. When the one press of Sign in of that sign-out pressed something (jobs/sign-in.ts), the push
// waits until that press had its minute, and says it did not help; a press that brought Teams back pushes nothing.
async function watchSignIn(a: Agent, teams: TeamsState) {
  const state = teams === "login" ? "problem" : teams === "ok" ? "fine" : "unknown";
  const w = parseState(Watch, a.store.getState(STATE.loginWatch));
  const tried = parseState(SignInTry, a.store.getState(STATE.signInTry));
  const pressed = w.since > 0 && tried.at >= w.since && tried.pressed.length > 0;
  const signInAfter = a.config.alerts.signInAfter ?? SIGN_IN_AFTER;
  const after = pressed ? Math.max(signInAfter, tried.at - w.since + (a.config.alerts.signInTryWait ?? SIGN_IN_TRY_WAIT)) : signInAfter;
  const { next, push } = watchProblem(state, w, { armed: !!a.store.getState(STATE.me), after, now: nowSeconds() });
  a.store.setState(STATE.loginWatch, JSON.stringify(next));
  if (push === "problem") {
    log.warn("SESSION", pressed ? "Teams still signed out after the Sign in button: alert pushed" : "Teams signed out: alert pushed");
    await a.notifier.alert("Teams signed out", `${pressed ? "The Sign in button did not help. " : ""}${a.config.alerts.signIn}: no messages until then.`);
  } else if (push === "fine") {
    log.info("SESSION", "Teams signed in again");
    await a.notifier.alert("Teams back", "Signed in again: messages are relayed.");
  } else if (state === "fine" && pressed) {
    log.info("SESSION", "Teams signed in again after the Sign in button: nothing pushed", { pressed: tried.pressed.join(",") });
  }
}

// One push when the browser has not started for a few minutes, one more when it runs again
async function watchBrowser(a: Agent, down: boolean) {
  const w = parseState(Watch, a.store.getState(STATE.browserWatch));
  const { next, push } = watchProblem(down ? "problem" : "fine", w, { armed: true, after: a.config.alerts.browserAfter ?? BROWSER_AFTER, now: nowSeconds() });
  a.store.setState(STATE.browserWatch, JSON.stringify(next));
  if (push === "problem") await a.notifier.alert("Relay browser down", `${a.config.alerts.browserDown}: see the log.`);
  else if (push === "fine") await a.notifier.alert("Relay browser back", "The browser runs again.");
}
