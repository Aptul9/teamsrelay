import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { showsPage } from "./logic/hosts";
import { errorText, log } from "./log";
import type { BrowserSource } from "./loop";
import { grantNotifications } from "./permissions";
import { sleep } from "./teams/page";

// Without a Teams tab for this long the agent exits and the supervisor starts it again
const NO_TAB_EXIT_MS = 60_000;

// The Chromium of a slot, reached over its DevTools port. The supervisor owns it: the agent never launches it, and
// closes it only when its own view of it is stuck (noTeamsTab). A closed connection (browser restarted, CDP dropped)
// is made again, the browser is not touched.
export class CdpBrowser implements BrowserSource {
  private browser: Browser | null = null;
  private current: BrowserContext | null = null;

  constructor(private readonly cdp: string) {}

  async context(): Promise<BrowserContext> {
    if (this.browser && this.current) {
      if (this.browser.isConnected()) return this.current;
      log.warn("cdp", "connection lost");
    }
    for (;;) {
      try {
        const browser = await chromium.connectOverCDP(this.cdp);
        const context = browser.contexts()[0];
        if (!context) {
          await browser.close();
          throw new Error("the browser has no context yet");
        }
        await grantNotifications(browser).catch(() => undefined);
        log.info("cdp", "connected", { cdp: this.cdp });
        [this.browser, this.current] = [browser, context];
        return context;
      } catch (e) {
        log.warn("cdp", `waiting: ${errorText(e)}`);
        await sleep(3000);
      }
    }
  }

  async noTeamsTab(_context: BrowserContext, { ms, url }: { ms: number; url: string }): Promise<boolean> {
    if (ms > NO_TAB_EXIT_MS) {
      // Only blank tabs through Playwright while Chromium lists a page: the view of the tab is stuck, and an agent
      // started again connects to the same stuck view (seen after a federated sign-in: the tab on Teams, to Playwright
      // a page with no address that never answers). The browser started again shows the tab.
      if (!url && (await this.chromiumShowsPage())) {
        log.warn("agent", "Chromium shows a page the agent cannot see: closing the browser, the supervisor starts it again");
        await this.closeBrowser();
      }
      log.warn("agent", "no Teams tab for 60 s: exiting, the supervisor starts the agent again");
      process.exit(1);
    }
    return false;
  }

  // The targets as Chromium lists them over HTTP, outside the Playwright connection
  private async chromiumShowsPage(): Promise<boolean> {
    try {
      const res = await fetch(new URL("/json/list", this.cdp), { signal: AbortSignal.timeout(5000) });
      return showsPage((await res.json()) as { type?: string; url?: string }[]);
    } catch {
      return false;
    }
  }

  private async closeBrowser() {
    try {
      const session = await this.browser?.newBrowserCDPSession();
      await session?.send("Browser.close");
    } catch (e) {
      log.warn("cdp", `browser not closed: ${errorText(e)}`);
    }
  }
}
