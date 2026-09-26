import type { Page } from "playwright-core";
import { STATE } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { wantedChat } from "../logic/parking";
import { errorText, log } from "../log";
import { drainNotifications, installNotificationHook, makeVisible } from "../teams/scripts/page-state";
import { TEXTS } from "../teams/selectors";

const initScripts = new WeakSet<Page>();

// Teams keeps the user Available only while its page is visible, focused and in use: the page says so from its
// first script on, and the notification hook captures what Teams shows
export async function preparePage(a: Agent) {
  const page = a.tp.page;
  if (!initScripts.has(page)) {
    await page.addInitScript(makeVisible).catch((e: unknown) => log.warn("page", `init script: ${errorText(e)}`));
    initScripts.add(page);
  }
  if ((await page.evaluate(makeVisible)) === "installed") log.info("page", "visible");
  if ((await page.evaluate(installNotificationHook)) === "installed") log.info("page", "notification hook installed");
}

// Real input through CDP, like a person at the desk: Teams keeps its endpoint active and the user Available
export async function keepActive(a: Agent) {
  try {
    await a.tp.page.mouse.move(6, 6);
    await a.tp.page.mouse.move(2, 2);
    await a.tp.page.keyboard.press("Shift");
  } catch (e) {
    log.warn("input", errorText(e));
  }
}

// Chat Teams should show now: the one in use in the app while the app shows it, otherwise the self chat
export function wanted(a: Agent): string {
  return wantedChat(a.store.getState(STATE.activeChat), a.store.getState(STATE.viewing), nowSeconds(), a.store.selfChat());
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
    log.info("MSG", n.title, { body: n.body });
    await a.notifier.message(n.title, n.body, a.store.isKnownChat(n.title) ? n.title : "");
  }
}
