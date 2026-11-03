import { setTimeout as sleep } from "node:timers/promises";
import { Identity, LightSignIn, parseState, STATE, Watch, type AgentHealth, type TeamsState } from "@/shared/slot-db/state";
import { nowSeconds } from "../context";
import { inApp } from "../jobs/page-setup";
import { pushMentions } from "../jobs/mentions";
import { pushMissedCalls } from "../jobs/missed-calls";
import { watchProblem } from "../logic/health";
import { errorText, log } from "../log";
import { z } from "zod";
import { union } from "../logic/check-seen";
import { lightFeed } from "./activity";
import type { Notification } from "./api";
import { lightHandlers, markRead, runLightCommands, saveChat } from "./commands";
import type { Light } from "./context";
import { lightList, listedChats, othersOf, presenceWord, unnamedPeople } from "./list";
import { CHATSVCAGG, IC3, PRESENCE, SignedOut, SPACES } from "./token";

// A light account signed out pushes after this long: the web app starts its browser to sign it in again within minutes
// of a refused or ended sign-in (src/lib/light.ts), only a sign-in that fails there lasts
const SIGN_IN_AFTER = 30 * 60;
// the access tokens are redeemed once more this long before the refresh token ends: they then outlive it by an hour,
// the time the browser run takes
const RENEW_BEFORE_MS = 10 * 60_000;
const HEALTH_EVERY_MS = 10_000;
const VIEWING_EVERY_MS = 5_000;

// The sign-in Microsoft refused, for the web app: its browser signs the account in again
function refused(l: Light, e: unknown): boolean {
  if (!(e instanceof SignedOut)) return false;
  if (!l.signedOut) log.warn("light", `sign-in refused: ${e.message}`);
  l.signedOut = true;
  const s = parseState(LightSignIn, l.store.getState(STATE.lightToken));
  if (!s.refused) l.store.setState(STATE.lightToken, JSON.stringify({ ...s, refused: true } satisfies LightSignIn));
  return true;
}

// Right before the refresh token ends, every access token once more
async function renewAhead(l: Light, renewed: { for: number }) {
  const s = l.token.stored();
  if (!s?.expiresOn || renewed.for === s.expiresOn || s.expiresOn * 1000 - Date.now() > RENEW_BEFORE_MS) return;
  renewed.for = s.expiresOn;
  l.token.renewAll();
  for (const scope of [IC3, CHATSVCAGG, SPACES, PRESENCE]) await l.token.accessToken(scope).catch(() => undefined);
  log.info("light", "access tokens renewed ahead of the end of the sign-in");
}

// Who you are, from the access token; the identity row of the account when the browser never wrote one
async function identify(l: Light) {
  const auth = await l.api.auth({});
  if (!auth.oid) throw new Error("no object id in the access token");
  const saved = parseState(Identity, l.store.getState(STATE.me));
  l.me = { oid: auth.oid, name: saved.name || auth.name || "" };
  if (!l.store.getState(STATE.me)) l.store.setState(STATE.me, JSON.stringify({ ...saved, name: auth.name ?? "", email: auth.upn ?? "" }));
}

// The chat list: saved complete, new messages notified as the browser agent does (src/agent/jobs/chat-list.ts)
export async function readList(l: Light): Promise<boolean> {
  try {
    if (!l.me.oid) await identify(l);
    const chats = await l.api.chats();
    const listed = listedChats(chats);
    const missing = unnamedPeople(listed, l.me.oid, l.people);
    if (missing.length) for (const [mri, p] of await l.api.people(missing).catch(() => new Map())) l.people.set(mri, p);
    const mine = `8:orgid:${l.me.oid}`;
    const watched = [...new Set([mine, ...listed.filter((c) => c.isOneOnOne).map((c) => othersOf(c, l.me.oid)[0]).filter(Boolean)])];
    const presence = await l.api.presence(watched).catch(() => new Map());
    const me = parseState(Identity, l.store.getState(STATE.me));
    const notes = await l.api.notesLast().catch(() => null);
    const { rows, ids } = lightList(chats, {
      me: l.me.oid,
      names: l.people,
      presence,
      mentioned: l.mentioned,
      now: new Date(),
      notes: notes && { name: `${me.name || l.me.name} (You)`, content: notes.content, time: notes.time },
    });
    l.list = { ids, names: new Map([...ids].map(([name, id]) => [id, name])), members: new Map(chats.map((c) => [c.id, othersOf(c, l.me.oid)])) };
    l.store.saveChats(rows, true);
    l.store.setState(STATE.lastScanTs, String(nowSeconds()));
    const own = presenceWord(presence.get(mine));
    if (own) l.store.setState(STATE.presence, own);
    await notifyNew(l, rows);
    l.scanAt = Date.now();
    l.error = "";
    l.signedOut = false;
    return true;
  } catch (e) {
    if (!refused(l, e)) {
      l.error = errorText(e);
      log.warn("chats", l.error);
    }
    return false;
  }
}

async function notifyNew(l: Light, rows: Parameters<Light["detector"]["scan"]>[0]) {
  for (const { chat, body } of l.detector.scan(rows)) {
    const shown = inApp(l, chat);
    log.info("NEWMSG", chat, { preview: body.slice(0, 50), inApp: shown || undefined });
    void saveChat(l, chat).catch(() => undefined);
    if (shown) void markRead(l, chat);
    else await l.notifier.message(chat, body, chat);
  }
  // a muted chat with something new: the feed tells whether it is a mention of you
  if (l.detector.takeMuted().length) l.due.activity = 0;
}

// The service gives more of the feed than the page shows (prod, 2026-11-03: 40 items back three weeks, 29 in the page):
// at its first read the light agent takes the items older than this as told, so a change of mode pushes no call or
// mention of weeks ago; newer ones may have come while the account changed mode, and push
const TOLD_BEFORE_START_MS = 10 * 60_000;

function tellOld(l: Light, items: readonly Notification[], since: number) {
  const old = items.filter((n) => (Date.parse(n.activity.activityTimestamp ?? "") || 0) < since).map((n) => String(n.activity.activityId));
  for (const key of [STATE.callsTold, STATE.mentionsTold]) {
    const raw = l.store.getState(key);
    const told = raw ? parseState(z.array(z.string()).catch([]), raw, []) : [];
    l.store.setState(key, JSON.stringify(union(told, old)));
  }
}

// The Activity feed: saved, its missed calls and the mentions the list does not tell pushed (src/agent/jobs/activity.ts)
export async function readFeed(l: Light): Promise<boolean> {
  if (!l.me.oid) return false;
  try {
    const items = await l.api.notifications();
    if (!l.feedRead) tellOld(l, items, l.startedAt - TOLD_BEFORE_START_MS);
    l.feedRead = true;
    const feed = lightFeed(items, (id) => l.list.names.get(id) ?? "", new Date());
    l.mentioned = new Set(items.filter((n) => !n.read && /mention/i.test(n.activity.activityType ?? "") && n.activity.sourceThreadId).map((n) => n.activity.sourceThreadId!));
    if (feed.length) l.store.saveActivity(feed);
    l.store.setState(STATE.activityTs, String(nowSeconds()));
    await pushMissedCalls(l);
    await pushMentions(l);
    return true;
  } catch (e) {
    if (!refused(l, e)) log.warn("activity", errorText(e));
    return false;
  }
}

// The health row of the web app, as the browser agent writes it (src/agent/jobs/health.ts)
async function writeHealth(l: Light) {
  const now = nowSeconds();
  const poll = l.config.lightPoll;
  const fresh = !!l.scanAt && Date.now() - l.scanAt < (2 * poll + 15) * 1000;
  const teams: TeamsState = l.signedOut ? "login" : fresh ? "ok" : l.scanAt || !l.error ? "loading" : "err";
  const h: AgentHealth = {
    cdp: "ok",
    ts: now,
    teams,
    push_subs: l.notifier.deviceCount(),
    last_msg_ts: l.store.lastNotificationTs(),
    last_scan_ts: Number(l.store.getState(STATE.lastScanTs)) || 0,
    watcher: fresh ? "ok" : "stale",
    overall: teams === "login" || teams === "err" ? "red" : fresh ? "green" : "yellow",
  };
  const w = parseState(Watch, l.store.getState(STATE.loginWatch));
  const { next, push } = watchProblem(teams === "login" ? "problem" : teams === "ok" ? "fine" : "unknown", w, { armed: !!l.store.getState(STATE.me), after: SIGN_IN_AFTER, now });
  l.store.setState(STATE.loginWatch, JSON.stringify(next));
  if (push === "problem") {
    log.warn("SESSION", "light account signed out: alert pushed");
    await l.notifier.alert("Teams signed out", "The browser of this light account could not sign it in again: set it to Always on in Settings and sign in on the remote desktop.");
  } else if (push === "fine") {
    await l.notifier.alert("Teams back", "Signed in again: messages are relayed.");
  }
  l.store.setState(STATE.teamsStatusPrev, teams);
  l.store.setState(STATE.health, JSON.stringify(h));
  l.health = h;
}

// The chat the app shows now, read again every few seconds: its new messages show as they come
async function readViewing(l: Light) {
  const chat = l.store.getState(STATE.activeChat);
  if (chat && inApp(l, chat)) await saveChat(l, chat).catch((e: unknown) => void refused(l, e));
}

export async function runLight(l: Light, signal?: AbortSignal): Promise<void> {
  const handlers = lightHandlers({ list: () => readList(l), activity: () => readFeed(l) });
  const renewed = { for: 0 };
  let healthAt = 0;
  let viewingAt = 0;
  while (!signal?.aborted) {
    const now = Date.now();
    try {
      await renewAhead(l, renewed);
      if (now >= l.due.list) {
        l.due.list = now + l.config.lightPoll * 1000;
        await readList(l);
      }
      if (now >= l.due.activity) {
        l.due.activity = now + l.config.lightPoll * 1000;
        await readFeed(l);
      }
      if (now >= viewingAt) {
        viewingAt = now + VIEWING_EVERY_MS;
        await readViewing(l);
      }
      if (now >= healthAt) {
        healthAt = now + HEALTH_EVERY_MS;
        await writeHealth(l);
      }
      await runLightCommands(l, handlers);
    } catch (e) {
      log.warn("loop", errorText(e));
    }
    await sleep(250);
  }
}
