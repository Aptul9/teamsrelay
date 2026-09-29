import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/agent/context";
import { browserDownHealth, noTabHealth, updateHealth } from "@/agent/jobs/health";
import type { Notifier } from "@/agent/push/notifier";
import type { TeamsPage } from "@/agent/teams/page";
import { openOverlays } from "@/agent/teams/scripts/message-actions";
import { uncoveredPoint } from "@/agent/teams/scripts/page-state";
import { SEL } from "@/agent/teams/selectors";
import { SlotStore } from "@/agent/store/slot-store";
import { nowSeconds } from "@/agent/context";
import { SIGN_IN_TRY_AFTER, SIGN_IN_TRY_WAIT } from "@/shared/sign-in";
import { AgentHealth, STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

let store: SlotStore;
let alerts: string[];

function agent(): Agent {
  return {
    config: { uploadsDir: "", activity: true, readBy: true, answerCalls: false, alerts:{ signInAfter: 60, browserAfter: 300, signIn: "Sign in again in the relay window", browserDown: "The browser of the relay does not start" } },
    store,
    notifier: { alert: async (title: string, body: string) => alerts.push(`${title}: ${body}`), deviceCount: () => 1 } as unknown as Notifier,
    // a loaded Teams page, for updateHealth
    tp: {
      page: {
        url: () => "https://teams.cloud.microsoft/v2/",
        evaluate: async () => ({ reduced: false, domReady: true, hookInstalled: true, presence: "available" }),
      },
    } as unknown as TeamsPage,
    health: null,
  } as unknown as Agent;
}

beforeEach(() => {
  store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  alerts = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-26T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

const later = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000);

describe("health of a Teams page away from its chats", () => {
  // the side bar shows (Activity clickable) but no chat list: since when, for the job that goes back to the chats
  function away(ready: { domReady: boolean }) {
    const a = agent();
    a.tp = {
      page: {
        url: () => "https://teams.cloud.microsoft/v2/",
        evaluate: async (fn: { name: string }) =>
          fn.name === "probePage" ? { reduced: false, domReady: ready.domReady, hookInstalled: true, presence: "available" } : fn.name === "uncoveredPoint" ? { x: 30, y: 60 } : 0,
      },
    } as unknown as TeamsPage;
    return a;
  }

  it("notes since when the side bar shows without the chat list, and forgets it with the list back, tries included", async () => {
    const ready = { domReady: false };
    const a = away(ready);
    await updateHealth(a);
    expect(a.health?.teams).toBe("loading");
    const since = a.loadingSince;
    expect(since).toBe(Date.now());
    later(10);
    await updateHealth(a);
    expect(a.loadingSince).toBe(since);
    a.backTries = 2;
    ready.domReady = true;
    await updateHealth(a);
    expect(a.loadingSince).toBeUndefined();
    expect(a.backTries).toBe(0);
  });
});

describe("health while the owner uses Teams", () => {
  it("says the remote desktop is in use while the agent leaves Teams to the owner, in a row the app reads", async () => {
    const a = agent();
    expect((await updateHealth(a)).desktop).toBeUndefined();
    a.ownerAt = Date.now();
    const h = await updateHealth(a);
    expect(h.desktop).toBe("in-use");
    expect(AgentHealth.safeParse(JSON.parse(store.getState(STATE.health))).data?.desktop).toBe("in-use");
    later(181);
    expect((await updateHealth(a)).desktop).toBeUndefined();
  });
});

describe("health without a Teams tab", () => {
  it("is loading on a blank tab and a sign-in on any other page, in a row the app reads", async () => {
    const a = agent();
    expect(await noTabHealth(a, "")).toMatchObject({ cdp: "ok", teams: "loading", overall: "yellow" });
    expect(await noTabHealth(a, "https://adfs.contoso.example/adfs/ls/")).toMatchObject({ cdp: "ok", teams: "login", overall: "red" });
    expect(AgentHealth.safeParse(JSON.parse(store.getState(STATE.health))).success).toBe(true);
    expect(store.getState(STATE.teamsStatusPrev)).toBe("login");
  });

  it("says the browser is down while it does not start", async () => {
    const h = await browserDownHealth(agent());
    expect(h).toMatchObject({ cdp: "ok", browser: "down", teams: "err", overall: "red" });
    expect(AgentHealth.safeParse(h).success).toBe(true);
  });
});

describe("side bar for the Activity job", () => {
  // the page as the health check reads it: the Activity button's free point and the open menus or dialogs
  function sideBar(a: Agent, state: { point: { x: number; y: number } | null; overlays: number }) {
    const probe = { reduced: false, domReady: true, hookInstalled: true, presence: "available" };
    const asked: unknown[] = [];
    const evaluate = async (fn: unknown, arg: unknown) => {
      if (fn === uncoveredPoint) asked.push(arg);
      if (fn === uncoveredPoint) return arg === SEL.activityView ? state.point : null;
      if (fn === openOverlays) return state.overlays;
      return probe;
    };
    a.tp = { page: { url: () => "https://teams.cloud.microsoft/v2/", evaluate } } as unknown as TeamsPage;
    return asked;
  }

  it("is ready once a point of the Activity button is free, not while the loading bar of Teams covers it", async () => {
    const a = agent();
    const state = { point: null as { x: number; y: number } | null, overlays: 0 };
    const asked = sideBar(a, state);
    expect((await updateHealth(a)).teams).toBe("ok");
    expect(a.railReady).toBe(false);
    state.point = { x: 34, y: 70 };
    await updateHealth(a);
    expect(a.railReady).toBe(true);
    expect(asked).toEqual([SEL.activityView, SEL.activityView]);
  });

  it("is ready under a menu or dialog, which the Activity job closes first", async () => {
    const a = agent();
    sideBar(a, { point: null, overlays: 1 });
    await updateHealth(a);
    expect(a.railReady).toBe(true);
  });

  it("is never read for a product without the Activity feed", async () => {
    const a = agent();
    a.config = { ...a.config, activity: false };
    const asked = sideBar(a, { point: { x: 34, y: 70 }, overlays: 0 });
    await updateHealth(a);
    expect(a.railReady).toBe(false);
    expect(asked).toEqual([]);
  });
});

describe("alerts of the health job", () => {
  it("push once when Teams stays signed out for a minute, and once more when it is back", async () => {
    store.setState(STATE.me, JSON.stringify({ name: "Test User", email: "test.user@contoso.example" }));
    const a = agent();
    const signInPage = "https://adfs.contoso.example/adfs/ls/";
    await noTabHealth(a, signInPage);
    later(59);
    await noTabHealth(a, signInPage);
    expect(alerts).toEqual([]);
    later(1);
    await noTabHealth(a, signInPage);
    later(30);
    await noTabHealth(a, signInPage);
    expect(alerts).toEqual(["Teams signed out: Sign in again in the relay window: no messages until then."]);
    // a blank tab says nothing about the session
    await noTabHealth(a, "");
    expect(alerts).toHaveLength(1);
    expect(await updateHealth(a)).toMatchObject({ teams: "ok" });
    expect(alerts).toEqual(["Teams signed out: Sign in again in the relay window: no messages until then.", "Teams back: Signed in again: messages are relayed."]);
    await updateHealth(a);
    expect(alerts).toHaveLength(2);
  });

  // the one press of Sign in (jobs/sign-in.ts) gets its minute before the owner is told
  it("after a press of Sign in, push only when Teams is still signed out a minute after it, saying the button did not help", async () => {
    store.setState(STATE.me, JSON.stringify({ name: "Test User", email: "test.user@contoso.example" }));
    const a = agent();
    const signInPage = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
    await noTabHealth(a, signInPage);
    later(SIGN_IN_TRY_AFTER);
    store.setState(STATE.signInTry, JSON.stringify({ at: nowSeconds(), pressed: ["teams"], microsoft: false }));
    later(60 - SIGN_IN_TRY_AFTER);
    await noTabHealth(a, signInPage);
    expect(alerts).toEqual([]);
    later(SIGN_IN_TRY_WAIT + SIGN_IN_TRY_AFTER - 60 - 1);
    await noTabHealth(a, signInPage);
    expect(alerts).toEqual([]);
    later(1);
    await noTabHealth(a, signInPage);
    expect(alerts).toEqual(["Teams signed out: The Sign in button did not help. Sign in again in the relay window: no messages until then."]);
  });

  it("after a press of Sign in that brought Teams back, push nothing at all", async () => {
    store.setState(STATE.me, JSON.stringify({ name: "Test User", email: "test.user@contoso.example" }));
    const a = agent();
    const signInPage = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
    await noTabHealth(a, signInPage);
    later(SIGN_IN_TRY_AFTER);
    store.setState(STATE.signInTry, JSON.stringify({ at: nowSeconds(), pressed: ["teams", "account"], microsoft: true }));
    // past the minute of a sign-out without a press, within the minute of the press
    later(50);
    await noTabHealth(a, signInPage);
    later(5);
    expect(await updateHealth(a)).toMatchObject({ teams: "ok" });
    later(120);
    await updateHealth(a);
    expect(alerts).toEqual([]);
  });

  it("with nothing pressed in that sign-out, push after a minute as before", async () => {
    store.setState(STATE.me, JSON.stringify({ name: "Test User", email: "test.user@contoso.example" }));
    const a = agent();
    const signInPage = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
    // an attempt of an earlier sign-out, and one of this sign-out that found nothing to press
    store.setState(STATE.signInTry, JSON.stringify({ at: nowSeconds() - 7200, pressed: ["teams"], microsoft: true }));
    await noTabHealth(a, signInPage);
    later(SIGN_IN_TRY_AFTER);
    later(60 - SIGN_IN_TRY_AFTER);
    await noTabHealth(a, signInPage);
    expect(alerts).toEqual(["Teams signed out: Sign in again in the relay window: no messages until then."]);
    store.setState(STATE.loginWatch, JSON.stringify({ since: 0, alerted: false }));
    alerts = [];
    await noTabHealth(a, signInPage);
    later(SIGN_IN_TRY_AFTER);
    store.setState(STATE.signInTry, JSON.stringify({ at: nowSeconds(), pressed: [], microsoft: false }));
    later(60 - SIGN_IN_TRY_AFTER);
    await noTabHealth(a, signInPage);
    expect(alerts).toEqual(["Teams signed out: Sign in again in the relay window: no messages until then."]);
  });

  it("push nothing for an account never signed in: its first sign-in is still to do", async () => {
    const a = agent();
    const signInPage = "https://login.example/";
    await noTabHealth(a, signInPage);
    later(3600);
    await noTabHealth(a, signInPage);
    expect(alerts).toEqual([]);
  });

  it("push once when the browser does not start for five minutes, and once more when it runs again", async () => {
    const a = agent();
    await browserDownHealth(a);
    later(299);
    await browserDownHealth(a);
    expect(alerts).toEqual([]);
    later(1);
    await browserDownHealth(a);
    expect(alerts).toEqual(["Relay browser down: The browser of the relay does not start: see the log."]);
    await noTabHealth(a, "");
    expect(alerts).toEqual(["Relay browser down: The browser of the relay does not start: see the log.", "Relay browser back: The browser runs again."]);
  });
});
