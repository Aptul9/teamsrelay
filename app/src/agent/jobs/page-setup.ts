import type { BrowserContext, Page } from "playwright-core";
import { Desktop, parseState, STATE, Viewing } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { DESKTOP_BRIDGE } from "../logic/desktop";
import { OWNER_PAUSE, ownerBusy } from "../logic/owner";
import { shownInApp, wantedChat } from "../logic/parking";
import { errorText, log } from "../log";
import { byAgent, withInput } from "../teams/input";
import { installMicHook } from "../teams/scripts/calls";
import { drainInput, drainNotifications, installNotificationHook, makeVisible, watchInput } from "../teams/scripts/page-state";
import { SEL, TEXTS } from "../teams/selectors";

const initScripts = new WeakSet<Page>();
const contextScripts = new WeakSet<BrowserContext>();

// Teams keeps the user Available only while its page is visible, focused and in use: the page says so from its
// first script on, and the notification hook captures what Teams shows. Where calls are answered from the app, the
// microphone hook of every page and frame of the browser tells the call in progress (jobs/calls.ts).
export async function preparePage(a: Agent) {
  const page = a.tp.page;
  if (!initScripts.has(page)) {
    await page.addInitScript(makeVisible).catch((e: unknown) => log.warn("page", `init script: ${errorText(e)}`));
    await page.addInitScript(watchInput).catch((e: unknown) => log.warn("page", `input init script: ${errorText(e)}`));
    initScripts.add(page);
  }
  if ((await page.evaluate(makeVisible)) === "installed") log.info("page", "visible");
  if ((await page.evaluate(installNotificationHook)) === "installed") log.info("page", "notification hook installed");
  if (a.config.answerCalls) await hookMicrophone(page);
  await noteOwnerInput(a);
}

// The owner's clicks, keys and wheel turns on the page since the last round (the remote desktop, the window of the local
// relay): what the page recorded, less the input the agent sent itself
export async function noteOwnerInput(a: Agent) {
  const page = a.tp.page;
  await page.evaluate(watchInput);
  const owner = ((await page.evaluate(drainInput)) ?? []).filter((t) => !byAgent(page, t));
  if (owner.length) a.ownerAt = Math.max(a.ownerAt ?? 0, ...owner);
  notePause(a);
}

// The pause of the jobs that move Teams, logged when it starts (with what started it) and when it ends
export function notePause(a: Agent) {
  const why = ownerWhy(a);
  if (!!why === !!a.ownerPaused) return;
  a.ownerPaused = !!why;
  if (why) log.info("page", "the owner uses Teams: the agent leaves it as it is", { by: why });
  else log.info("page", "the owner left Teams: parking and presence keeper again");
}

// The owner uses Teams now: the jobs that move Teams wait (presence keeper, parking, back to the chats, list sweep,
// feed, Read by, the press of Sign in)
export function ownerUses(a: Agent, now = Date.now()): boolean {
  return ownerWhy(a, now) !== null;
}

// Where the agent watches the remote desktop (jobs/desktop.ts): while the owner has it open with the window of this
// account in front, and from a click on the desktop link of the app until the connection shows (DESKTOP_BRIDGE at
// most); nothing is left once it closes. Elsewhere (the window of the local relay on the owner's own screen, or the
// connections of the desktop not readable): the owner's clicks, keys and wheel turns, and the desktop link, OWNER_PAUSE
// seconds each.
function ownerWhy(a: Agent, now = Date.now()): "desktop" | "link" | "input" | null {
  const link = parseState(Desktop, a.store.getState(STATE.desktop)).ts * 1000;
  if (a.config.desktop && !a.desktopUnknown) {
    if (a.onDesktop) return "desktop";
    return now - link < DESKTOP_BRIDGE * 1000 && (a.desktopSeenAt ?? 0) < link ? "link" : null;
  }
  if (!ownerBusy(a.ownerAt ?? 0, link / 1000, now)) return null;
  return now - (a.ownerAt ?? 0) < OWNER_PAUSE * 1000 ? "input" : "link";
}

// In the pages and frames to come (a call window included) before Teams asks for the microphone, and in those open now
async function hookMicrophone(page: Page) {
  const context = page.context();
  if (!contextScripts.has(context)) {
    await context.addInitScript(installMicHook).catch((e: unknown) => log.warn("page", `microphone init script: ${errorText(e)}`));
    contextScripts.add(context);
  }
  let installed = 0;
  for (const frame of page.frames()) if ((await frame.evaluate(installMicHook).catch(() => "failed")) === "installed") installed++;
  if (installed) log.info("page", "microphone hook installed", { frames: installed });
}

// Teams shows an answered call in its main window, and once the call is over it can leave a post-meeting page there
// (prod, 2026-09-29): the side bar shows, the chat list does not, the health says loading, and every job that moves
// Teams waits for Teams "ok". Back to the chats AFTER_CALL_MS after a call, AWAY_MS after anything else (someone may
// browse Teams in the desktop meanwhile), again RETRY_MS after a try that brought no list back.
const AFTER_CALL_MS = 3_000;
const AFTER_CALL_WINDOW_MS = 120_000;
const AWAY_MS = 120_000;
const RETRY_MS = 15_000;
const BACK_TRIES = 3;

export function awayFromChats(a: Agent, now = Date.now()): boolean {
  if (a.inCall || a.ringing || a.health?.teams !== "loading" || !a.railReady || !a.loadingSince || ownerUses(a, now)) return false;
  if (a.backTries) return now - (a.backAt ?? 0) >= RETRY_MS;
  const sinceCall = a.callOverAt ? now - a.callOverAt : Infinity;
  return (sinceCall >= AFTER_CALL_MS && sinceCall <= AFTER_CALL_WINDOW_MS) || now - a.loadingSince >= AWAY_MS;
}

// The Chat button of the side bar; after BACK_TRIES tries that brought no list back, Teams again (a reload)
export async function backToChats(a: Agent) {
  const tries = (a.backTries ?? 0) + 1;
  a.backAt = Date.now();
  a.callOverAt = undefined;
  if (tries > BACK_TRIES) {
    a.backTries = 0;
    a.loadingSince = Date.now();
    log.warn("page", "still no chat list after the Chat button: Teams reloaded");
    await a.tp.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e: unknown) => log.warn("page", `reload: ${errorText(e)}`));
    return;
  }
  a.backTries = tries;
  log.warn("page", "the side bar shows but no chat list: back to Chat", { try: tries });
  await withInput(a.tp.page, () => a.tp.clickRail(SEL.chatView, 2000)).catch((e: unknown) => log.warn("page", `back to Chat: ${errorText(e)}`));
}

// Real input through CDP, like a person at the desk: Teams keeps its endpoint active and the user Available
export async function keepActive(a: Agent) {
  const page = a.tp.page;
  try {
    // never in the middle of a click or a shortcut of the call watch
    await withInput(page, async () => {
      await page.mouse.move(6, 6);
      await page.mouse.move(2, 2);
      await page.keyboard.press("Shift");
    });
  } catch (e) {
    log.warn("input", errorText(e));
  }
}

// Chat Teams should show now: the one in use in the app while the app shows it, otherwise the self chat
export function wanted(a: Agent): string {
  return wantedChat(a.store.getState(STATE.activeChat), a.store.getState(STATE.viewing), nowSeconds(), a.store.selfChat());
}

// The app shows this chat now and Teams holds it open for it: a message there is read as it comes, in Teams and in the
// app, and needs no notification
export function inApp(a: Agent, chat: string): boolean {
  const viewing = parseState(Viewing, a.store.getState(STATE.viewing));
  return !!chat && a.store.getState(STATE.activeChat) === chat && shownInApp(viewing, nowSeconds()) === chat;
}

// The visible page reads what is open: after a reload Teams reopens a chat of its own choosing, put right here
export async function park(a: Agent, want: string) {
  if (!want || a.store.hasPendingCommands() || (await a.tp.isOpen(want))) return;
  log.info("show", want);
  await a.tp.openChat(want);
}

// Notifications captured by the hook, a second source of new messages. Their title names the chat only when it is
// a chat of the list: in a group chat it may be the person who wrote, and a tap would open another chat.
export async function drainHook(a: Agent) {
  for (const n of await a.tp.page.evaluate(drainNotifications)) {
    if (n.title === TEXTS.healthTag || TEXTS.ownNotification.test(n.title)) continue;
    const chat = a.store.isKnownChat(n.title) ? n.title : "";
    const shown = inApp(a, chat);
    log.info("MSG", n.title, { body: n.body, inApp: shown || undefined });
    if (!shown) await a.notifier.message(n.title, n.body, chat);
  }
}
