import type { Page } from "playwright-core";
import { sameChat } from "../logic/chats";
import { errorText, log } from "../log";
import type { SlotStore } from "../store/slot-store";
import { openChatTitle, clickChatRow, scrollChatList } from "./scripts/chat-list";
import { composerLeft } from "./scripts/compose";
import { barButtonPoint, centerElement, openOverlays } from "./scripts/message-actions";
import { uncoveredPoint } from "./scripts/page-state";
import { SEL, TEXTS } from "./selectors";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What became of a message the agent sent: sent (Teams shows it sent), failed (it never left the compose box), or
// unconfirmed (Enter went, Teams did not show it sent in time: it may be out, sending it again may make two)
export type SendResult = "sent" | "failed" | "unconfirmed";

// What a send runs as soon as the message went, while Teams still shows it sending: the handlers save the chat, so
// that the web app, which waits for the message in the saved chat, sees it at once
export type AfterPress = () => Promise<unknown>;

export async function afterPress(fn?: AfterPress) {
  try {
    await fn?.();
  } catch (e) {
    log.warn("send", `after the send: ${errorText(e)}`);
  }
}

// A message by id, for Node-side locators
export const messageSelector = (mid: string) => `${SEL.message}[data-mid="${mid.replace(/["\\]/g, "\\$&")}"]`;

// The Teams page of the slot and the moves shared by every action: opening a chat, closing menus, the real
// mouse hover that makes the action bar of a message appear.
export class TeamsPage {
  // chats a sweep of the whole list did not find, and when
  private readonly missed = new Map<string, number>();

  constructor(
    readonly page: Page,
    private readonly store: SlotStore,
  ) {}

  openTitle(): Promise<string> {
    return this.page.evaluate(openChatTitle, SEL);
  }

  sameChat(title: string, name: string): boolean {
    return sameChat(title, name, (n) => this.store.isKnownChat(n));
  }

  async isOpen(name: string): Promise<boolean> {
    return this.sameChat(await this.openTitle(), name);
  }

  // Opens the chat unless Teams shows it already: clicks its row and waits until Teams shows it (the messages of
  // the previous chat are still in the page for a moment), then takes the list back to the top, where the chats
  // with new messages are
  async openChat(name: string): Promise<boolean> {
    if (await this.isOpen(name).catch(() => false)) return true;
    const clicked = await this.clickRow(name);
    let open = false;
    for (let i = 0; i < 24 && clicked && !open; i++) {
      open = await this.isOpen(name).catch(() => false);
      if (!open) await sleep(250);
    }
    await this.page.evaluate(scrollChatList, { s: SEL, to: "top" as const }).catch(() => false);
    if (!clicked) return false;
    if (!open) {
      log.warn("open", "chat did not open", { chat: name });
      return false;
    }
    await this.page.waitForSelector(SEL.message, { timeout: 3000 }).catch(() => undefined);
    await sleep(400);
    return true;
  }

  // The list is virtualized: only the rows in view are in the page. The row of that exact name, the list scrolled
  // down from the top to reach it; a name that only starts the same as a last resort. Parking and the Read by
  // prefetch ask again every few rounds: a name a sweep missed is not swept for again within 30 s.
  private async clickRow(name: string): Promise<boolean> {
    const click = (exact: boolean) => this.page.evaluate(clickChatRow, { s: SEL, t: TEXTS, name, exact });
    if (await click(true)) return true;
    if (Date.now() - (this.missed.get(name) ?? 0) < 30_000) return false;
    const scroll = (to: "top" | "down") => this.page.evaluate(scrollChatList, { s: SEL, to });
    await scroll("top");
    for (let i = 0; i < 9; i++) {
      await sleep(400);
      if (await click(true)) {
        this.missed.delete(name);
        return true;
      }
      if (!(await scroll("down"))) break;
    }
    this.missed.set(name, Date.now());
    await scroll("top");
    await sleep(400);
    return click(false);
  }

  // Menus or dialogs left open over the chat would catch the mouse: Escape, up to three times
  async clearOverlays(): Promise<boolean> {
    for (let i = 0; i < 3; i++) {
      if (!(await this.page.evaluate(openOverlays, SEL))) return true;
      await this.page.keyboard.press("Escape");
      await sleep(400);
    }
    return false;
  }

  // Empties the compose box after a send that went wrong: what is left there would go out with the next message.
  // True once the box is checked empty.
  async emptyComposeBox(): Promise<boolean> {
    await this.page.keyboard.press("Escape").catch(() => undefined);
    for (let i = 0; i < 3; i++) {
      try {
        // focus, not a click: the click could land on an image or a person tagged, which open their menus
        await this.page.locator(SEL.editor).last().focus({ timeout: 2000 });
        await this.page.keyboard.press("Control+A");
        await this.page.keyboard.press("Delete");
        await sleep(300);
        if (!(await this.page.evaluate(composerLeft, SEL))) return true;
      } catch {
        // tried again
      }
    }
    log.warn("compose", "compose box not emptied: the next message would carry what is left");
    return false;
  }

  // The action bar shows up only with a real mouse over the message: synthetic events are ignored
  async hoverMessage(mid: string): Promise<boolean> {
    const m = this.page.locator(messageSelector(mid));
    if ((await m.count()) === 0) return false;
    const bar = this.page.locator(`${SEL.actionBar}:visible`);
    for (let i = 0; i < 4; i++) {
      try {
        await m.evaluate(centerElement);
        const box = await m.boundingBox();
        if (!box) {
          await sleep(300);
          continue;
        }
        // straight mouse moves: Playwright's hover() waits for the Teams animations, up to 10 s
        await this.page.mouse.move(2, 2);
        await sleep(100);
        await this.page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 20), { steps: 3 });
        await bar.first().waitFor({ timeout: 1500 });
        return true;
      } catch {
        await sleep(300);
      }
    }
    return false;
  }

  // Hover, then a click on button `tid` of the bar by its coordinates: the mouse jumps there without
  // crossing other messages
  async clickBarButton(mid: string, tid: string): Promise<boolean> {
    for (let i = 0; i < 3; i++) {
      if (!(await this.hoverMessage(mid))) return false;
      const point = await this.page.evaluate(barButtonPoint, { s: SEL, mid, tid });
      if (point) {
        await this.page.mouse.click(point.x, point.y);
        return true;
      }
      await sleep(300);
    }
    return false;
  }

  async mouseAway() {
    await this.page.mouse.move(2, 2).catch(() => undefined);
  }

  // A button of the Teams rail (Activity, Chat), clicked with the mouse brought first to a part of it nothing
  // covers. Left on the app launcher (mouseAway, presence keeper), the mouse keeps the launcher tooltip open over
  // the Activity button, and the tooltip stays while the mouse is on it: a click there never lands. While Teams
  // starts, the button is not there yet or its loading bar covers all of it: up to `waitMs` for a free point.
  async clickRail(selector: string, waitMs = 0) {
    const until = Date.now() + waitMs;
    let point = await this.railPoint(selector);
    while (!point && Date.now() < until) {
      await sleep(250);
      point = await this.railPoint(selector);
    }
    if (point) await this.page.mouse.move(point.x, point.y);
    await this.page.locator(`${selector}:visible`).first().click({ timeout: 4000 });
  }

  // none while the page navigates (a start goes through the sign-in hosts)
  private railPoint(selector: string) {
    return this.page.evaluate(uncoveredPoint, selector).catch(() => null);
  }
}
