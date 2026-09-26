import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { errorText, log } from "./log";
import type { BrowserSource } from "./loop";
import { sleep } from "./teams/page";

// Without a Teams tab for this long the agent exits and the supervisor starts it again
const NO_TAB_EXIT_MS = 60_000;

// The Chromium of a slot, reached over its DevTools port. The supervisor owns it: the agent never launches or closes
// it. A closed connection (browser restarted, CDP dropped) is made again, the browser is not touched.
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
        await context.grantPermissions(["notifications"]).catch(() => undefined);
        log.info("cdp", "connected", { cdp: this.cdp });
        [this.browser, this.current] = [browser, context];
        return context;
      } catch (e) {
        log.warn("cdp", `waiting: ${errorText(e)}`);
        await sleep(3000);
      }
    }
  }

  async noTeamsTab(_context: BrowserContext, { ms }: { ms: number }): Promise<boolean> {
    if (ms > NO_TAB_EXIT_MS) {
      log.warn("agent", "no Teams tab for 60 s: exiting, the supervisor starts the agent again");
      process.exit(1);
    }
    return false;
  }
}
