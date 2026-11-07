import type { Page } from "playwright-core";
import { ownerInput, withInput } from "./input";
import { watchInput } from "./scripts/page-state";

const handled = new WeakMap<Page, number>();
const ownerUntil = new WeakMap<Page, number>();

export async function continueMcas(page: Page): Promise<boolean> {
  const url = new URL(page.url());
  if (url.protocol !== "https:" || url.username || url.password || !/^[a-z0-9-]+\.access\.mcas\.ms$/i.test(url.hostname) || url.port || url.pathname !== "/aad_login") return false;
  const normal = await page.evaluate(() => {
    const c = (window as unknown as { context?: Record<string, unknown> }).context;
    return !!c && c.TITLE_ID === "PROXYWEB_MONITORED_ACCESS_MESSAGE" && c.DESCRIPTION_ID === "PROXYWEB_MONITORED_ACCESS_DESCRIPTION" && c.DISPLAY_DISCLAIMER === true && !c.CUSTOMIZED_TITLE && !c.CUSTOMIZED_BODY && !c.WAIT_FOR_APP_ONBOARDING && !c.APP_ONBOARDING_SHOW_CONTINUE && !c.BYPASS_NON_SUFFIX_SUPPORTED_APP_FOR_ADMIN && !c.SECOND_LOGIN_INFORMATION_PAGE_ENABLED && c.REDIRECT_TO_SUFFIX_METHOD === "POST";
  }).catch(() => false);
  if (!normal || (await page.evaluate(watchInput).catch(() => null)) !== "already") return false;
  return withInput(page, async () => {
    if ((await ownerInput(page)).length) ownerUntil.set(page, Date.now() + 30_000);
    if (Date.now() < (ownerUntil.get(page) ?? 0)) return false;
    const documentAt = await page.evaluate(() => performance.timeOrigin);
    if (handled.get(page) === documentAt) return false;
    if (await page.locator('input[type="password"], input[type="email"], input[name="otc"]').count()) return false;
    const button = page.getByRole("button", { name: /^Continue$/i });
    if (await button.count() !== 1 || !await button.isVisible() || !await button.isEnabled()) return false;
    const hide = page.getByRole("checkbox", { name: /(?:don't|do not).*show.*week|hide.*week/i });
    if (await hide.count() === 1 && await hide.isVisible() && await hide.isEnabled()) await hide.check({ timeout: 2000 });
    await button.click({ timeout: 3000 });
    handled.set(page, documentAt);
    return true;
  });
}
