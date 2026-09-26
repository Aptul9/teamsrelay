import fs from "node:fs";
import { chromium, type BrowserContext } from "playwright-core";
import type { BrowserSource } from "@/agent/loop";
import { isLoginUrl, isTeamsUrl } from "@/agent/logic/hosts";
import { errorText, log } from "@/agent/log";
import { sleep } from "@/agent/teams/page";

// Defaults of Playwright that a browser kept open for months must not have: they stop Safe Browsing, certificate
// revocation lists and the other components from updating
const KEEP_UPDATING = ["--disable-background-networking", "--disable-component-update", "--disable-client-side-phishing-detection"];

export type LaunchOptions = { profileDir: string; channel: string; headless?: boolean };

// The browser of the relay, on a profile of its own. Never the profile of the everyday browser: since Chromium 136
// remote debugging, the pipe Playwright drives it through included, is ignored on the default user data directory,
// and the Microsoft session of the relay stays apart from personal browsing. Headful: the window is where the
// sign-in happens, and where it happens again when the session expires. The cookies stay in the profile, as in a
// browser used every day.
export async function launchBrowser(o: LaunchOptions): Promise<BrowserContext> {
  fs.mkdirSync(o.profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(o.profileDir, {
    channel: o.channel,
    headless: o.headless ?? false,
    // the page takes the size of the window, as in a browser opened by hand
    viewport: null,
    // Playwright adds --no-sandbox otherwise; this browser renders whatever arrives in Teams
    chromiumSandbox: true,
    ignoreDefaultArgs: KEEP_UPDATING,
    args: ["--window-size=1280,1000"],
  });
  await context.grantPermissions(["notifications"]).catch(() => undefined);
  // The browser may restore tabs of its previous session: one is kept, the Teams one if there, else the blank one
  // the launch opens
  const pages = context.pages();
  const keep = pages.find((p) => isTeamsUrl(p.url()) || isLoginUrl(p.url())) ?? pages.find((p) => p.url() === "about:blank") ?? pages[0];
  for (const page of pages) if (page !== keep) await page.close().catch(() => undefined);
  return context;
}

// Opens Teams in the tab of the browser, a new one if there is none
export async function openTeams(context: BrowserContext, teamsUrl: string) {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(teamsUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e: unknown) => log.warn("browser", `open Teams: ${errorText(e)}`));
}

// Keeps the browser running for the agent loop: launched on first use, and again when it closed (window closed,
// crash). Launches that keep failing, or browsers that close soon after they start, wait longer each time, up to a
// minute.
export class BrowserKeeper implements BrowserSource {
  private current: BrowserContext | null = null;
  private failures = 0;
  private startedAt = 0;
  private stopped = false;

  constructor(
    private readonly launch: () => Promise<BrowserContext>,
    private readonly teamsUrl: string,
  ) {}

  async context(): Promise<BrowserContext> {
    if (this.stopped) throw new Error("the relay is stopping");
    if (this.current) return this.current;
    if (this.failures) await sleep(Math.min(60_000, 1000 * 2 ** (this.failures - 1)));
    let context: BrowserContext;
    try {
      context = await this.launch();
    } catch (e) {
      this.failures++;
      throw e;
    }
    if (this.stopped) {
      await context.close().catch(() => undefined);
      throw new Error("the relay is stopping");
    }
    this.current = context;
    this.startedAt = Date.now();
    context.on("close", () => {
      if (this.current !== context) return;
      this.current = null;
      this.failures = Date.now() - this.startedAt < 60_000 ? this.failures + 1 : 0;
      log.warn("browser", "closed: starting it again");
    });
    log.info("browser", "started");
    if (!context.pages().some((p) => isTeamsUrl(p.url()) || isLoginUrl(p.url()))) await this.openTeams(context);
    return context;
  }

  openTeams(context: BrowserContext): Promise<void> {
    return openTeams(context, this.teamsUrl);
  }

  // Closes the browser for good (the relay stops): nothing launches it again
  async close() {
    this.stopped = true;
    const context = this.current;
    this.current = null;
    await context?.close().catch(() => undefined);
  }
}
