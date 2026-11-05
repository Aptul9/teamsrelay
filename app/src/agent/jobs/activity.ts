import { STATE } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { lightFeed } from "../light/activity";
import { notificationsOf, notificationsUrl, type NotificationsReply } from "../light/api";
import { errorText, log } from "../log";
import { cachedConversationId, getTeamsAuth, syncIndexedDbMappings } from "../teams/chatsvc";
import { sleep } from "../teams/page";
import { readActivityFeed, type FeedItem } from "../teams/scripts/activity";
import { scrollList } from "../teams/scripts/chat-list";
import { SEL, TEXTS } from "../teams/selectors";
import type { ActivityEntry } from "../store/slot-store";
import { wanted } from "./page-setup";

const FEED_LIMIT = 40;

// The feed through chatsvc with the token of the page, as a light account reads it (src/agent/light/activity.ts): a few
// hundred ms, where the page takes Teams to the Activity view and back in about 20 s with every command of the app
// waiting (Npo, 2026-11-05). The pictures the page copied before stay, a new item takes the one of its person's chat.
// Number of items saved; null when chatsvc does not serve it.
export async function readActivityApi(a: Agent): Promise<number | null> {
  try {
    const page = a.tp.page;
    if (typeof page.context !== "function") return null;
    const auth = await getTeamsAuth(page.context(), page);
    if (!auth) return null;
    const r = await fetch(notificationsUrl(auth.region), {
      headers: { Accept: "application/json", Authorization: `Bearer ${auth.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      log.warn("activity", `chatsvc: HTTP ${r.status}`);
      return null;
    }
    const notes = notificationsOf((await r.json()) as NotificationsReply);
    await syncIndexedDbMappings(page);
    const chats = a.store.chats();
    const pictures = a.store.activityAvatars();
    const items = lightFeed(notes, (conv) => chats.find((c) => cachedConversationId(c.name) === conv)?.name ?? "", new Date()).map((e) => ({
      ...e,
      av: pictures.get(e.id) || chats.find((c) => c.name === e.actor)?.av || "",
    }));
    if (!items.length) return null;
    a.store.saveActivity(items);
    a.store.setState(STATE.activityTs, String(nowSeconds()));
    return items.length;
  } catch (e) {
    log.warn("activity", `chatsvc: ${errorText(e)}`);
    return null;
  }
}

// Reads the Teams Activity feed, through chatsvc, else in the page and back to the chat view. Number of items read, or
// null. railWait: milliseconds the side bar may take to show up clickable (a refresh asked while Teams starts); the way
// back does not wait again, the side bar was clickable or the page never left the chat view.
export async function readActivity(a: Agent, railWait = 0): Promise<number | null> {
  const fast = await readActivityApi(a);
  if (fast !== null) return fast;
  const page = a.tp.page;
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
      const want = wanted(a);
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
