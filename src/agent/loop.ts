import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { STATE } from "@/shared/slot-db/state";
import { runPendingCommands } from "./commands";
import type { Agent } from "./context";
import { readActivity } from "./jobs/activity";
import { scanChats, scanChatsFull } from "./jobs/chat-list";
import { saveOpenChat } from "./jobs/conversation";
import { noTabHealth, updateHealth } from "./jobs/health";
import { saveIdentity } from "./jobs/identity";
import { drainHook, keepActive, park, preparePage, wanted } from "./jobs/page-setup";
import { prefetchReadBy } from "./jobs/read-by";
import { scheduledSelfCheck, selfCheckDue } from "./jobs/self-check";
import { isTeamsUrl, pickTeamsPage } from "./logic/hosts";
import { errorText, log } from "./log";
import { Scheduler, type Job } from "./scheduler";
import { sleep, TeamsPage } from "./teams/page";

// Seconds between two inputs on the Teams page
export const ACTIVE_EVERY = 60;
// Without a Teams tab for this long the agent exits and Docker starts it again (restart: unless-stopped)
const NO_TAB_EXIT_MS = 60_000;

type Round = { onTeams: boolean; want: string };

// The agent loop of agent.py, one job per step, in the same order and at the same rounds
export function agentJobs(a: Agent): Job<Round>[] {
  const teamsOk = () => a.health?.teams === "ok";
  const active = () => a.store.getState(STATE.activeChat);
  return [
    { name: "page", every: { rounds: 1 }, run: () => preparePage(a) },
    { name: "input", every: { seconds: ACTIVE_EVERY }, run: () => keepActive(a) },
    { name: "parking", every: { rounds: 5, offset: 2 }, run: (r) => park(a, r.want) },
    { name: "hook", every: { rounds: 1 }, run: () => drainHook(a) },
    { name: "commands", every: { rounds: 1 }, run: () => runPendingCommands(a) },
    // until Teams is connected (sign-in to do, session expired) there is nothing to scroll or read
    { name: "chats-full", every: { rounds: 300, offset: 1 }, when: teamsOk, run: () => scanChatsFull(a) },
    { name: "chats", every: { rounds: 3 }, run: () => scanChats(a) },
    { name: "activity", every: { rounds: 150, offset: 5 }, when: teamsOk, run: () => readActivity(a) },
    { name: "identity", every: { rounds: 300, offset: 7 }, force: () => !a.store.getState(STATE.me), when: teamsOk, run: () => saveIdentity(a) },
    { name: "health", every: { rounds: 5 }, anyPage: true, run: () => updateHealth(a) },
    {
      name: "conversation",
      every: { rounds: 1 },
      run: async () => {
        const chat = active();
        if (chat) await saveOpenChat(a, chat);
      },
    },
    {
      name: "read-by",
      every: { rounds: 2 },
      when: (r) => !!r.want && active() === r.want && teamsOk() && !a.store.hasPendingCommands(),
      run: (r) => prefetchReadBy(a, r.want),
    },
    { name: "self-check", every: { rounds: 1 }, when: () => !!selfCheckDue(a), run: () => scheduledSelfCheck(a) },
  ];
}

async function connect(cdp: string): Promise<{ browser: Browser; context: BrowserContext }> {
  for (;;) {
    try {
      const browser = await chromium.connectOverCDP(cdp);
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close();
        throw new Error("the browser has no context yet");
      }
      await context.grantPermissions(["notifications"]).catch(() => undefined);
      log.info("cdp", "connected", { cdp });
      return { browser, context };
    } catch (e) {
      log.warn("cdp", `waiting: ${errorText(e)}`);
      await sleep(3000);
    }
  }
}

export async function runAgent(a: Omit<Agent, "tp" | "health">): Promise<never> {
  const agent = { ...a, health: null } as Agent;
  const scheduler = new Scheduler<Round>(agentJobs(agent), (job, e) => log.warn("job", errorText(e), { job }));
  const pages = new WeakMap<Page, TeamsPage>();
  let { browser, context } = await connect(a.config.cdp);
  let noTabSince: number | null = null;
  for (;;) {
    try {
      // a closed connection (browser restarted, CDP dropped): a new one, the browser is not touched
      if (!browser.isConnected()) {
        log.warn("cdp", "connection lost");
        ({ browser, context } = await connect(a.config.cdp));
      }
      const page = pickTeamsPage(context.pages());
      if (!page) {
        noTabHealth(agent);
        noTabSince ??= Date.now();
        if (Date.now() - noTabSince > NO_TAB_EXIT_MS) {
          log.warn("agent", "no Teams tab for 60 s: exiting, Docker starts the agent again");
          process.exit(1);
        }
        await sleep(3000);
        continue;
      }
      noTabSince = null;
      let tp = pages.get(page);
      if (!tp) {
        tp = new TeamsPage(page, agent.store);
        pages.set(page, tp);
      }
      agent.tp = tp;
      const onTeams = isTeamsUrl(page.url());
      await scheduler.runRound({ onTeams, want: onTeams ? wanted(agent) : "" });
    } catch (e) {
      log.warn("loop", errorText(e));
      await sleep(2000);
    }
    await sleep(1000);
  }
}
