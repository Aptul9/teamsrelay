import type { Page } from "playwright-core";
import { SIGN_IN_TRY_AFTER, SIGN_IN_TRY_EVERY, SIGN_IN_TRY_WAIT } from "@/shared/sign-in";
import { Identity, parseState, SignInTry, STATE, Watch } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { hostOf, isLoginUrl, isTeamsUrl } from "../logic/hosts";
import { log } from "../log";
import { visibleButtons } from "../teams/scripts/sign-in";
import { SEL } from "../teams/selectors";
import { pressMicrosoft, pressTeamsSignIn } from "../teams/sign-in-actions";

const NONE: SignInTry = { at: 0, pressed: [], microsoft: false };

// What was logged for the sign-out of each agent (the one that started at `since`): the pages whose buttons were
// listed, the attempt skipped for being too close to the last one
const told = new WeakMap<Agent, { since: number; pages: Set<string>; skipped: boolean }>();

// Often a sign-out needs only a press of Teams' own Sign in: the session the browser still holds signs in again by
// itself. Once per sign-out, SIGN_IN_TRY_AFTER seconds into it: Teams' Sign in, then, for SIGN_IN_TRY_WAIT seconds, one
// press on Microsoft's sign-in page (this account's tile, or its one Sign in or Continue), never where it asks for
// something to type. Then nothing more: the health job tells the owner if Teams is still signed out. Never for an
// account never signed in (its first sign-in is the owner's), nor once the owner was told, nor within
// SIGN_IN_TRY_EVERY seconds of the last attempt. The buttons of each page are logged once per sign-out: none of these
// screens was ever read on an account, the next real sign-out says what they show.
export async function trySignIn(a: Agent) {
  const now = nowSeconds();
  const w = parseState(Watch, a.store.getState(STATE.loginWatch), { since: 0, alerted: false });
  const me = a.store.getState(STATE.me);
  if (!w.since || w.alerted || !me) return;
  const seen = toldOf(a, w.since);
  let t = parseState(SignInTry, a.store.getState(STATE.signInTry), NONE);
  if (t.at < w.since) {
    if (now - w.since < (a.config.alerts.signInTryAfter ?? SIGN_IN_TRY_AFTER)) return;
    if (t.at && now - t.at < SIGN_IN_TRY_EVERY) {
      if (!seen.skipped) log.info("SESSION", `signed out again within ${SIGN_IN_TRY_EVERY / 60} min of the last Sign in attempt: nothing pressed`);
      seen.skipped = true;
      return;
    }
    t = { at: now, pressed: [], microsoft: false };
    save(a, t);
    const page = a.tp.page;
    if (isTeamsUrl(page.url())) {
      log.info("SESSION", "signed out: pressing the Sign in of Teams once");
      await logButtons(page, seen);
      if (await pressTeamsSignIn(page)) {
        t.pressed.push("teams");
        save(a, t);
        log.info("SESSION", "Sign in pressed in Teams");
      } else log.info("SESSION", "no single Sign in of Teams to press: nothing pressed");
    }
  }
  if (t.microsoft || now - t.at >= (a.config.alerts.signInTryWait ?? SIGN_IN_TRY_WAIT)) return;
  const page = microsoftPage(a);
  if (!page) return;
  await logButtons(page, seen);
  const done = await pressMicrosoft(page, parseState(Identity, me, { name: "", email: "", tenant: "", av: "" }).email);
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
  const fresh = { since, pages: new Set<string>(), skipped: false };
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

// Once per sign-out and page address (without its query)
async function logButtons(page: Page, seen: { pages: Set<string> }) {
  const where = page.url().split("?")[0];
  if (seen.pages.has(where)) return;
  const buttons = await page.evaluate(visibleButtons, SEL).catch(() => null);
  if (!buttons) return;
  seen.pages.add(where);
  log.info("SESSION", "sign-in page buttons", { host: hostOf(page.url()), buttons: buttons.join(" | ") });
}
