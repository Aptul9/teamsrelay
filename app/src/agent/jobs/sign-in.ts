import type { Page } from "playwright-core";
import { SIGN_IN_TRY_AFTER, SIGN_IN_TRY_EVERY, SIGN_IN_TRY_WAIT } from "@/shared/sign-in";
import { Identity, parseState, SignInTry, STATE, Watch } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { hostOf, isLoginUrl, isTeamsUrl } from "../logic/hosts";
import { log } from "../log";
import { signInPage } from "../teams/scripts/sign-in";
import { SEL, TEXTS } from "../teams/selectors";
import { pressMicrosoft, pressTeamsSignIn } from "../teams/sign-in-actions";

// What was logged for the sign-out of each agent (the one that started at `since`): the pages whose buttons were
// listed, the attempt skipped for being too close to the last one, the pages listed once the owner was told
const told = new WeakMap<Agent, { since: number; pages: Set<string>; skipped: boolean; listed: boolean }>();

// Often a sign-out needs only a press of Teams' own Sign in: the session the browser still holds signs in again by
// itself. Once per sign-out, from SIGN_IN_TRY_AFTER seconds into it and once Teams shows its Sign in or a Microsoft
// sign-in page shows (a start of Teams can read signed out for a while, on the hosts of the sign-in and of the proxy of
// the tenant, then loading: nothing to act on there): Teams' Sign in, then, for SIGN_IN_TRY_WAIT seconds, one press on
// Microsoft's sign-in page (this account's tile, or its one Sign in or Continue), never where it asks for something to
// type. Then nothing more: the health job tells the owner if Teams is still signed out. Never for an account never
// signed in (its first sign-in is the owner's), nor once the owner was told, nor within SIGN_IN_TRY_EVERY seconds of
// an attempt that pressed something. The buttons of each page are logged once per sign-out, at the attempt, or when
// the owner is told without one: none of these screens was ever read on an account, the next real sign-out says what
// they show.
export async function trySignIn(a: Agent) {
  const now = nowSeconds();
  const w = parseState(Watch, a.store.getState(STATE.loginWatch));
  const me = a.store.getState(STATE.me);
  if (!w.since || !me) return;
  const seen = toldOf(a, w.since);
  let t = parseState(SignInTry, a.store.getState(STATE.signInTry));
  if (t.at < w.since) {
    if (w.alerted) {
      if (!seen.listed) for (const page of signOutPages(a)) await logButtons(page, seen);
      seen.listed = true;
      return;
    }
    if (now - w.since < (a.config.alerts.signInTryAfter ?? SIGN_IN_TRY_AFTER)) return;
    if (t.at && t.pressed.length && now - t.at < SIGN_IN_TRY_EVERY) {
      if (!seen.skipped) log.info("SESSION", `signed out again within ${SIGN_IN_TRY_EVERY / 60} min of the last Sign in attempt: nothing pressed`);
      seen.skipped = true;
      return;
    }
    const page = a.tp.page;
    const onTeams = isTeamsUrl(page.url());
    const button = onTeams && !!(await page.evaluate(signInPage, { s: SEL, t: TEXTS }).catch(() => null))?.teams.at;
    if (!button && !microsoftPage(a)) return;
    t = { at: now, pressed: [], microsoft: false };
    save(a, t);
    log.info("SESSION", "signed out: one attempt to sign in again");
    if (onTeams) {
      await logButtons(page, seen);
      if (button && (await pressTeamsSignIn(page))) {
        t.pressed.push("teams");
        save(a, t);
        log.info("SESSION", "Sign in pressed in Teams");
      } else log.info("SESSION", "no single Sign in of Teams to press: nothing pressed");
    }
  }
  if (w.alerted || t.microsoft || now - t.at >= (a.config.alerts.signInTryWait ?? SIGN_IN_TRY_WAIT)) return;
  const page = microsoftPage(a);
  if (!page) return;
  await logButtons(page, seen);
  const done = await pressMicrosoft(page, parseState(Identity, me).email);
  if (!done) return;
  t.microsoft = true;
  if (done === "account" || done === "button") t.pressed.push(done);
  save(a, t);
  const host = hostOf(page.url());
  if (done === "asks") log.info("SESSION", "Microsoft asks for something to type: nothing pressed", { host });
  else if (done === "owner") log.info("SESSION", "the owner is on the Microsoft sign-in page: nothing pressed", { host });
  else log.info("SESSION", done === "account" ? "this account pressed on the Microsoft sign-in page" : "Sign in or Continue pressed on the Microsoft sign-in page", { host });
}

function save(a: Agent, t: SignInTry) {
  a.store.setState(STATE.signInTry, JSON.stringify(t));
}

function toldOf(a: Agent, since: number) {
  const known = told.get(a);
  if (known?.since === since) return known;
  const fresh = { since, pages: new Set<string>(), skipped: false, listed: false };
  told.set(a, fresh);
  return fresh;
}

// The page on Microsoft's sign-in host: the popup Teams' Sign in opened, or the Teams tab itself sent there
function microsoftPage(a: Agent): Page | null {
  const pages = a.tp.page
    .context()
    .pages()
    .filter((p) => !p.isClosed() && isLoginUrl(p.url()));
  return pages.at(-1) ?? null;
}

// The pages of a sign-out: the Teams tab (or the page the agent drives), and those on Microsoft's sign-in host
function signOutPages(a: Agent): Page[] {
  const login = a.tp.page
    .context()
    .pages()
    .filter((p) => p !== a.tp.page && !p.isClosed() && isLoginUrl(p.url()));
  return [a.tp.page, ...login];
}

// Once per sign-out and page address (without its query)
async function logButtons(page: Page, seen: { pages: Set<string> }) {
  const where = page.url().split("?")[0];
  if (seen.pages.has(where)) return;
  const buttons = (await page.evaluate(signInPage, { s: SEL, t: TEXTS }).catch(() => null))?.buttons;
  if (!buttons) return;
  seen.pages.add(where);
  log.info("SESSION", "sign-in page buttons", { host: hostOf(page.url()), buttons: buttons.join(" | ") });
}
