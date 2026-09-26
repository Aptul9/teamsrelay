import type { Page } from "playwright-core";
import { sameChat } from "../logic/chats";
import { log } from "../log";
import type { SlotStore } from "../store/slot-store";
import { openChatTitle, clickChatRow } from "./scripts/chat-list";
import { barButtonPoint, centerElement, openOverlays } from "./scripts/message-actions";
import { SEL, TEXTS } from "./selectors";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A message by id, for Node-side locators
export const messageSelector = (mid: string) => `${SEL.message}[data-mid="${mid.replace(/["\\]/g, "\\$&")}"]`;

// The Teams page of the slot and the moves shared by every action: opening a chat, closing menus, the real
// mouse hover that makes the action bar of a message appear.
export class TeamsPage {
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

  // Clicks the row of the chat and waits until Teams shows it: the messages of the previous chat are still in
  // the page for a moment
  async openChat(name: string): Promise<boolean> {
    if (!(await this.page.evaluate(clickChatRow, { s: SEL, t: TEXTS, name }))) return false;
    let open = false;
    for (let i = 0; i < 24 && !open; i++) {
      open = await this.isOpen(name).catch(() => false);
      if (!open) await sleep(250);
    }
    if (!open) {
      log.warn("open", "chat did not open", { chat: name });
      return false;
    }
    await this.page.waitForSelector(SEL.message, { timeout: 3000 }).catch(() => undefined);
    await sleep(400);
    return true;
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
}
