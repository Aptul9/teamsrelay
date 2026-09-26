import { describe, expect, it } from "vitest";
import { computeHealth, sessionExpired, type PageProbe } from "@/agent/logic/health";
import { AgentHealth } from "@/shared/slot-db/state";

const NOW = 1_790_419_968;
const teamsPage: PageProbe = { url: "https://teams.cloud.microsoft/v2/", reduced: false, domReady: true, hookInstalled: true, presence: "available" };
const health = (probe: PageProbe | null, lastScanTs = NOW - 5) => computeHealth({ probe, pushSubs: 2, lastMsgTs: NOW - 100, lastScanTs, now: NOW });

describe("health row", () => {
  it("is green on a loaded Teams page with a fresh chat list", () => {
    expect(health(teamsPage)).toEqual({
      cdp: "ok",
      ts: NOW,
      teams: "ok",
      reduced: false,
      hook: "ok",
      presence: "available",
      push_subs: 2,
      last_msg_ts: NOW - 100,
      last_scan_ts: NOW - 5,
      watcher: "ok",
      overall: "green",
    });
  });

  it("is what the web app reads", () => {
    expect(AgentHealth.safeParse(health(teamsPage)).success).toBe(true);
    expect(AgentHealth.safeParse(health(null)).success).toBe(true);
  });

  it("is red on the sign-in page or when Teams lost the session", () => {
    expect(health({ ...teamsPage, url: "https://login.microsoftonline.com/common/oauth2/authorize" })).toMatchObject({ teams: "login", overall: "red" });
    expect(health({ ...teamsPage, reduced: true })).toMatchObject({ teams: "login", reduced: true, overall: "red" });
  });

  it("is red when the page could not be read", () => {
    const h = health(null);
    expect(h).toMatchObject({ teams: "err", hook: "no", overall: "red" });
    expect(h).not.toHaveProperty("presence");
    expect(h).not.toHaveProperty("reduced");
  });

  // like the Python agent, overall looks at the chat list only: a page still loading with a fresh list is green
  it("is yellow when the chat list is older than a minute", () => {
    expect(health({ ...teamsPage, domReady: false })).toMatchObject({ teams: "loading", overall: "green" });
    expect(health(teamsPage, NOW - 61)).toMatchObject({ watcher: "stale", overall: "yellow" });
    expect(health(teamsPage, 0)).toMatchObject({ watcher: "stale", overall: "yellow" });
  });

  it("has no presence outside the Teams page", () => {
    const login: PageProbe = { url: "https://login.live.com/", reduced: false, domReady: false, hookInstalled: false };
    expect(health(login)).not.toHaveProperty("presence");
  });
});

describe("expired session push", () => {
  it("fires once, when the state turns to login, for an account signed in before", () => {
    expect(sessionExpired("login", "ok", true)).toBe(true);
    expect(sessionExpired("login", "login", true)).toBe(false);
    expect(sessionExpired("login", "", false)).toBe(false);
    expect(sessionExpired("ok", "login", true)).toBe(false);
  });
});
