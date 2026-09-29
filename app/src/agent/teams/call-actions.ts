import type { Page } from "playwright-core";
import { withInput } from "./input";
import { uncoveredPoint } from "./scripts/page-state";
import { SEL } from "./selectors";

// Answer asked from the app: a real click on Accept with audio of the toast on screen, at a point of the button nothing
// covers, sent as CDP mouse events at that point. No wait for the toast to hold still: Teams animates it while the call
// rings, and a click that waits for a still button waited 3 s and landed after its own timeout (prod, 2026-09-29). False
// when no toast shows, or when all of Accept is covered.
export async function acceptCall(page: Page): Promise<boolean> {
  return withInput(page, async () => {
    const at = await page.evaluate(uncoveredPoint, SEL.callAccept).catch(() => null);
    if (!at) return false;
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
      return true;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  });
}

// The shortcut of Teams web that accepts an audio call, Alt+Shift+S (Microsoft support, "Keyboard shortcuts for
// Microsoft Teams", web column): where Accept could not be clicked, or its click did not take
export async function acceptShortcut(page: Page): Promise<void> {
  await withInput(page, () => page.keyboard.press("Alt+Shift+KeyS"));
}

// Hang-up asked from the app: the shortcut of Teams web that ends a call, Ctrl+Shift+H (same table)
export async function hangUp(page: Page): Promise<void> {
  await withInput(page, () => page.keyboard.press("Control+Shift+H"));
}
