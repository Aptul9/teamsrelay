import type { BrowserContext, Page } from "playwright-core";
import { STATE } from "@/shared/slot-db/state";
import { runPendingCommands } from "./commands";
import type { Agent } from "./context";
import { readActivity } from "./jobs/activity";
import { CallWatch } from "./jobs/calls";
import { scanChats, scanChatsFull } from "./jobs/chat-list";
import { saveOpenChat } from "./jobs/conversation";
import { browserDownHealth, noTabHealth, updateHealth } from "./jobs/health";
import { saveIdentity } from "./jobs/identity";
import { pruneMedia } from "./jobs/media";
import { FeedAfterCalls, pushMissedCalls } from "./jobs/missed-calls";
import { awayFromChats, backToChats, drainHook, keepActive, park, preparePage, wanted } from "./jobs/page-setup";
import { prefetchReadBy } from "./jobs/read-by";
import { scheduledSelfCheck, selfCheckDue } from "./jobs/self-check";
import { hostOf, isTeamsUrl, pickTeamsPage } from "./logic/hosts";
import { errorText, log } from "./log";
import { Scheduler, type Job } from "./scheduler";
import { sleep, TeamsPage } from "./teams/page";

// Seconds between two inputs on the Teams page
export const ACTIVE_EVERY = 60;
export const ACTIVITY_RETRY = 30;
// Pages that show nothing: a tab just opened, an error page of the browser
const BLANK = /^(about:|chrome:|edge:|chrome-error:)/;

type Round = { onTeams: boolean; want: string };

// The agent loop of agent.py, one job per step, in the same order and at the same rounds. Activity feed and
// "Read by" only for a product whose app shows them. afterCalls: the feed is read out of its turn soon after a call
// ended, and each read alerts the missed calls it shows first (an account checked every N hours: its check does).
export function agentJobs(a: Agent, afterCalls = new FeedAfterCalls()): Job<Round>[] {
  const teamsOk = () => a.health?.teams === "ok";
  // while a call rings (an answer clicks its toast) and during a call (the call view stays on screen) the jobs that move
  // Teams to a chat or the feed wait; commands of the app go on, asked by the owner
  const free = () => teamsOk() && !a.inCall && !a.ringing;
  const active = () => a.store.getState(STATE.activeChat);
  // a feed read that failed is tried once more ACTIVITY_RETRY seconds later, not 150 rounds later
  let retryAt = 0;
  const activity = async () => {
    const retry = retryAt > 0;
    retryAt = 0;
    afterCalls.ran();
    if ((await readActivity(a)) === null) {
      if (!retry) retryAt = Date.now() + ACTIVITY_RETRY * 1000;
      return;
    }
    if (!a.checkedOnly?.()) await pushMissedCalls(a);
  };
  const jobs: (Job<Round> | false)[] = [
    { name: "page", every: { rounds: 1 }, run: () => preparePage(a) },
    { name: "input", every: { seconds: ACTIVE_EVERY }, run: () => keepActive(a) },
    // the side bar without the chat list (the page a call leaves in the main window): back to the chats
    { name: "back-to-chats", every: { rounds: 1 }, when: () => awayFromChats(a), run: () => backToChats(a) },
    // no chat to open before Teams shows its list: right after a start, or with a sign-in to do
    { name: "parking", every: { rounds: 5, offset: 2 }, when: free, run: (r) => park(a, r.want) },
    { name: "hook", every: { rounds: 1 }, run: () => drainHook(a) },
    { name: "commands", every: { rounds: 1 }, run: () => runPendingCommands(a) },
    // until Teams is connected (sign-in to do, session expired) there is nothing to scroll or read
    { name: "chats-full", every: { rounds: 300, offset: 1 }, when: free, run: () => scanChatsFull(a) },
    { name: "chats", every: { rounds: 3 }, run: () => scanChats(a) },
    // Teams is still loading at round 5 after a start: read once its side bar can be clicked, not 150 rounds later
    a.config.activity && {
      name: "activity",
      every: { rounds: 150, offset: 5 },
      force: () => (retryAt > 0 && Date.now() >= retryAt) || afterCalls.due(),
      when: () => free() && !!a.railReady,
      catchUp: true,
      run: activity,
    },
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
    a.config.readBy && {
      name: "read-by",
      every: { rounds: 2 },
      when: (r) => !!r.want && active() === r.want && free() && !a.store.hasPendingCommands(),
      run: (r) => prefetchReadBy(a, r.want),
    },
    // the first time 31 rounds after a start, which has usually read the list, the feed and the account by then (rows left
    // from before keep their files anyway); off the rounds of the list and the health
    { name: "media", every: { rounds: 300, offset: 31 }, run: () => pruneMedia(a) },
    // an account started only to be checked has its checks: its start would find Teams still loading
    { name: "self-check", every: { rounds: 1 }, when: () => !!selfCheckDue(a) && !a.checkedOnly?.() && !a.inCall && !a.ringing, run: () => scheduledSelfCheck(a) },
  ];
  return jobs.filter((j): j is Job<Round> => !!j);
}

// The browser as the loop sees it. Where it comes from belongs to the product: the Chromium of a slot reached over
// its DevTools port (src/agent/cdp.ts), or the browser the local relay launches on its profile (src/local/browser.ts).
export type BrowserSource = {
  // The browser context of the moment. Throws while there is no browser: the loop reports it and asks again.
  context(): Promise<BrowserContext>;
  // No Teams tab for `ms` milliseconds; `url` is the page shown instead, "" for a blank tab. True when the source
  // did something about it (Teams opened again in the tab): the count starts again.
  noTeamsTab(context: BrowserContext, away: { ms: number; url: string }): Promise<boolean>;
};

// About one round a second, until `signal` aborts (never, for the agent of a slot)
export async function runAgent(a: Omit<Agent, "tp" | "health">, browser: BrowserSource, signal?: AbortSignal): Promise<void> {
  const agent = { ...a, health: null } as Agent;
  const afterCalls = new FeedAfterCalls();
  const scheduler = new Scheduler<Round>(agentJobs(agent, afterCalls), (job, e) => log.warn("job", errorText(e), { job }));
  // incoming calls on a timer of their own: a call rings a few seconds, a round can take longer
  new CallWatch(agent, undefined, undefined, () => afterCalls.callEnded()).start(signal);
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
        // the page that is not blank, if any: a sign-in on another host (federated sign-in page, MFA) looks like this
        const url = context.pages().map((p) => p.url()).find((u) => !BLANK.test(u)) ?? "";
        await noTabHealth(agent, url);
        if (!away || !!away.url !== !!url) {
          away = { since: Date.now(), url };
          log.info("agent", url ? "not on Teams" : "blank tab", { host: url ? hostOf(url) : undefined });
        }
        if (await browser.noTeamsTab(context, { ms: Date.now() - away.since, url })) away = null;
        await sleep(3000);
        continue;
      }
      away = null;
      let tp = pages.get(page);
      if (!tp) {
        tp = new TeamsPage(page, agent.store);
        pages.set(page, tp);
        // a new tab (browser restarted): its side bar is not known clickable until the next health check
        agent.railReady = false;
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
