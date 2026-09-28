import type { Browser } from "playwright-core";

// Notifications only, in the default context of the browser. Playwright's grantPermissions sends
// Browser.grantPermissions, which denies every permission it does not list on every origin: the microphone of a call
// included, over the managed policy of the browsers image that gives it to the Teams origins. Chromium drops the grant
// with the CDP session that made it, so the session stays open as long as the connection.
export async function grantNotifications(browser: Browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    await session.send("Browser.setPermission", { permission: { name: "notifications" }, setting: "granted" });
  } catch (e) {
    await session.detach().catch(() => undefined);
    throw e;
  }
}
