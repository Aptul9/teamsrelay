import { STATE } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { wantedChat } from "../logic/parking";
import { errorText, log } from "../log";
import { sleep } from "../teams/page";
import { readActivityFeed, type FeedItem } from "../teams/scripts/activity";
import { scrollList } from "../teams/scripts/chat-list";
import { SEL, TEXTS } from "../teams/selectors";
import type { ActivityEntry } from "../store/slot-store";

const FEED_LIMIT = 40;

// Reads the Teams Activity feed and goes back to the chat view. Number of items read, or null. railWait: milliseconds
// the side bar may take to show up clickable (a refresh asked while Teams starts); the way back does not wait again,
// the side bar was clickable or the page never left the chat view.
export async function readActivity(a: Agent, railWait = 0): Promise<number | null> {
  const page = a.tp.page;
  const active = a.store.getState(STATE.activeChat);
  let items: ActivityEntry[] | null = null;
  try {
    await a.tp.clearOverlays();
    await a.tp.clickRail(SEL.activityView, railWait);
    await page.locator(SEL.feedItem).first().waitFor({ timeout: 8000 });
    await sleep(500);
    // this list is virtualized too: scroll and collect by id
    const seen = new Map<string, FeedItem>();
    for (let i = 0; i < 6; i++) {
      for (const item of await page.evaluate(readActivityFeed, { s: SEL, t: TEXTS })) seen.set(item.id || item.title + item.tm, item);
      if (seen.size >= FEED_LIMIT || !(await page.evaluate(scrollList, { item: SEL.feedItem, to: "down" as const }))) break;
      await sleep(600);
    }
    items = await a.media.avatars(page, [...seen.values()].slice(0, FEED_LIMIT), FEED_LIMIT);
  } catch (e) {
    log.warn("activity", errorText(e));
  } finally {
    // always back to Chat: the rest of the agent works on the chat view
    try {
      await a.tp.clickRail(SEL.chatView);
      await page.locator(SEL.anyChatRow).first().waitFor({ timeout: 8000 });
      const want = wantedChat(active, a.store.getState(STATE.viewing), nowSeconds(), a.store.selfChat());
      if (want) await a.tp.openChat(want);
    } catch (e) {
      log.warn("activity", `back to chat: ${errorText(e)}`);
    }
  }
  if (!items?.length) return null;
  a.store.saveActivity(items);
  a.store.setState(STATE.activityTs, String(nowSeconds()));
  return items.length;
}
