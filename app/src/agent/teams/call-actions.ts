import type { Page } from "playwright-core";
import { SEL } from "./selectors";

// Answer asked from the app: a real click (CDP mouse) on Accept with audio of the toast on screen. False when no toast
// shows, or when it went away under the click (the call stopped ringing).
export async function acceptCall(page: Page): Promise<boolean> {
  const button = page.locator(SEL.callAccept).filter({ visible: true }).first();
  if (!(await button.count())) return false;
  try {
    await button.click({ timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// Hang-up asked from the app: the shortcut of Teams web that ends a call, Ctrl+Shift+H (Microsoft support, "Keyboard
// shortcuts for Microsoft Teams", web column)
export async function hangUp(page: Page): Promise<void> {
  await page.keyboard.press("Control+Shift+H");
}
