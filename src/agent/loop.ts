import type { BrowserContext, Page } from "playwright-core";
import { STATE } from "@/shared/slot-db/state";
import { runPendingCommands } from "./commands";
import type { Agent } from "./context";
import { scanChats, scanChatsFull } from "./jobs/chat-list";
import { saveOpenChat } from "./jobs/conversation";
import { browserDownHealth, noTabHealth, updateHealth } from "./jobs/health";
import { saveIdentity } from "./jobs/identity";
import { drainHook, keepActive, park, preparePage, wanted } from "./jobs/page-setup";
import { scheduledSelfCheck, selfCheckDue } from "./jobs/self-check";
import { hostOf, isTeamsUrl, pickTeamsPage } from "./logic/hosts";
import { errorText, log } from "./log";
import { Scheduler, type Job } from "./scheduler";
import { sleep, TeamsPage } from "./teams/page";

// Seconds between two inputs on the Teams page
export const ACTIVE_EVERY = 60;
// A blank tab gets Teams again after this long; a tab on any other page is left alone for longer: it may be a
// sign-in in progress (federated sign-in page, MFA)
const BLANK_TAB_MS = 5_000;
const OTHER_PAGE_MS = 10 * 60_000;
const BLANK = /^(about:|chrome:|edge:|chrome-error:)/;

type Round = { onTeams: boolean; want: string };

// The agent loop of teamsrelay, one job per step, in the same order and at the same rounds, less the Activity feed
// and "Read by"
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
    { name: "self-check", every: { rounds: 1 }, when: () => !!selfCheckDue(a), run: () => scheduledSelfCheck(a) },
  ];
}

// The browser as the loop sees it: the context of the moment (launched again after it closed or failed) and the
// way back to Teams in its tab
export type BrowserSource = {
  context(): Promise<BrowserContext>;
  openTeams(context: BrowserContext): Promise<void>;
};

// About one round a second until `signal` aborts (never, in the relay). The relay owns the browser: a closed browser
// is launched again, a tab away from Teams is sent back to it.
export async function runAgent(a: Omit<Agent, "tp" | "health">, browser: BrowserSource, signal?: AbortSignal): Promise<void> {
  const agent = { ...a, health: null } as Agent;
  const scheduler = new Scheduler<Round>(agentJobs(agent), (job, e) => log.warn("job", errorText(e), { job }));
  const pages = new WeakMap<Page, TeamsPage>();
  let away: { since: number; url: string } | null = null;
  while (!signal?.aborted) {
    try {
      let context: BrowserContext;
      try {
        context = await browser.context();
      } catch (e) {
        log.warn("browser", `not started: ${errorText(e)}`);
        await browserDownHealth(agent);
        await sleep(2000);
        continue;
      }
      const page = pickTeamsPage(context.pages());
      if (!page) {
        // the page that is not blank, if any: its host decides how long it is left alone
        const url = context.pages().map((p) => p.url()).find((u) => !BLANK.test(u)) ?? "";
        await noTabHealth(agent, url);
        if (!away || !!away.url !== !!url) {
          away = { since: Date.now(), url };
          log.info("agent", url ? "not on Teams" : "blank tab", { host: url ? hostOf(url) : undefined });
        }
        if (Date.now() - away.since > (url ? OTHER_PAGE_MS : BLANK_TAB_MS)) {
          log.warn("agent", url ? "not on Teams for 10 minutes: opening Teams" : "no Teams tab: opening Teams", { host: url ? hostOf(url) : undefined });
          await browser.openTeams(context);
          away = null;
        }
        await sleep(3000);
        continue;
      }
      away = null;
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
