// The one press of Sign in after a sign-out (jobs/sign-in.ts), with a fake browser: the Teams tab, and the page on the
// Microsoft sign-in host that Teams' button opens (a popup) or that the Teams tab itself went to. What each page shows
// comes from the tests; the presses are the CDP mouse presses the job sends, by page. Nothing before 15 s signed out,
// one attempt per sign-out (a restart included), one press on Microsoft's page at most and never on a page that asks
// for something to type or where the owner types, 30 min between two attempts.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/agent/context";
import { trySignIn } from "@/agent/jobs/sign-in";
import { log } from "@/agent/log";
import type { Notifier } from "@/agent/push/notifier";
import { SlotStore } from "@/agent/store/slot-store";
import type { TeamsPage } from "@/agent/teams/page";
import { SIGN_IN_TRY_AFTER, SIGN_IN_TRY_EVERY, SIGN_IN_TRY_WAIT } from "@/shared/sign-in";
import { parseState, SignInTry, STATE } from "@/shared/slot-db/state";
import { tempDir } from "../helpers";

type Point = { x: number; y: number };
type Shown = {
  teams?: { asks: boolean; found: number; at: Point | null };
  microsoft?: { asks: boolean; accounts: number; account: Point | null; buttons: number; button: Point | null };
  // times of real input on the page (the owner's)
  input?: number[];
};
type Fake = { name: string; url: string; shown: Shown; watched?: boolean };

const EMAIL = "test.user@contoso.example";
const TEAMS_URL = "https://teams.cloud.microsoft/v2/";
const LOGIN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=5e3ce6c0";
const T0 = new Date("2026-09-29T10:00:00Z").getTime();
const at = { x: 40, y: 12 };
const tile = { asks: false, accounts: 1, account: { x: 200, y: 150 }, buttons: 0, button: null };

let store: SlotStore;
let presses: string[];
let pages: Fake[];
const made = new Map<Fake, object>();

// a page of the fake browser, the same object each time: evaluate answers the page scripts by name, the CDP session
// records the presses
function fakePage(f: Fake): object {
  const known = made.get(f);
  if (known) return known;
  const page = {
    url: () => f.url,
    isClosed: () => false,
    evaluate: async (fn: { name: string }) => {
      if (fn.name === "teamsSignIn") return f.shown.teams ?? { asks: false, found: 0, at: null };
      if (fn.name === "microsoftSignIn") return f.shown.microsoft ?? { asks: false, accounts: 0, account: null, buttons: 0, button: null };
      if (fn.name === "visibleButtons") return ["Sign in"];
      if (fn.name === "watchInput") {
        const first = !f.watched;
        f.watched = true;
        return first ? "installed" : "already";
      }
      if (fn.name === "drainInput") return (f.shown.input ?? []).splice(0);
      return null;
    },
    context: () => ({
      pages: () => pages.map(fakePage),
      newCDPSession: async () => ({
        send: async (method: string, p: { type?: string; x?: number; y?: number }) => {
          if (method === "Input.dispatchMouseEvent" && p.type === "mousePressed") presses.push(`${f.name}@${p.x},${p.y}`);
        },
        detach: async () => undefined,
      }),
    }),
  };
  made.set(f, page);
  return page;
}

function agent(): Agent {
  return {
    config: { uploadsDir: "", activity: true, readBy: true, answerCalls: true, alerts: { signInAfter: 60, browserAfter: 300, signIn: "Sign in again", browserDown: "down" } },
    store,
    notifier: { alert: async () => undefined, deviceCount: () => 1 } as unknown as Notifier,
    tp: { page: fakePage(pages[0]) } as unknown as TeamsPage,
    health: { cdp: "ok", ts: 0, teams: "login", overall: "red" },
  } as unknown as Agent;
}

const later = (s: number) => vi.setSystemTime(Date.now() + s * 1000);
const tried = () => parseState(SignInTry, store.getState(STATE.signInTry), { at: 0, pressed: [], microsoft: false });
// Teams signed out from now on, as the health job keeps it; and signed in again
const signedOut = (alerted = false) => store.setState(STATE.loginWatch, JSON.stringify({ since: Math.floor(Date.now() / 1000), alerted }));
const back = () => store.setState(STATE.loginWatch, JSON.stringify({ since: 0, alerted: false }));
const popup = (shown: Shown) => pages.push({ name: "popup", url: LOGIN_URL, shown });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  store = SlotStore.open(path.join(tempDir(), "1", "messages.db"));
  store.setState(STATE.me, JSON.stringify({ name: "Test User", email: EMAIL, tenant: "Contoso", av: "" }));
  presses = [];
  made.clear();
  pages = [{ name: "teams", url: TEAMS_URL, shown: { teams: { asks: true, found: 1, at } } }];
});

afterEach(() => vi.useRealTimers());

describe("one press of Sign in after a sign-out", () => {
  it("waits 15 s, presses Teams' own Sign in once, and never again in that sign-out, a restart included", async () => {
    const a = agent();
    signedOut();
    later(SIGN_IN_TRY_AFTER - 1);
    await trySignIn(a);
    expect(presses).toEqual([]);
    later(1);
    await trySignIn(a);
    expect(presses).toEqual(["teams@40,12"]);
    expect(tried()).toMatchObject({ at: Math.floor(Date.now() / 1000), pressed: ["teams"] });
    later(5);
    await trySignIn(a);
    await trySignIn(agent());
    expect(presses).toEqual(["teams@40,12"]);
  });

  it("presses this account on Microsoft's page once, a round after that page first shows, in the popup of the press", async () => {
    const a = agent();
    signedOut();
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    popup({ microsoft: tile });
    await trySignIn(a);
    // first seen: its input watched from now on, nothing pressed yet
    expect(presses).toEqual(["teams@40,12"]);
    later(1);
    await trySignIn(a);
    expect(presses).toEqual(["teams@40,12", "popup@200,150"]);
    expect(tried()).toMatchObject({ pressed: ["teams", "account"], microsoft: true });
    later(1);
    await trySignIn(a);
    expect(presses).toHaveLength(2);
  });

  it("presses the one Sign in or Continue of Microsoft's page when no tile names this account", async () => {
    const a = agent();
    signedOut();
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    popup({ microsoft: { asks: false, accounts: 0, account: null, buttons: 1, button: { x: 90, y: 300 } } });
    await trySignIn(a);
    later(1);
    await trySignIn(a);
    expect(presses).toEqual(["teams@40,12", "popup@90,300"]);
    expect(tried().pressed).toEqual(["teams", "button"]);
  });

  it("works on the Teams tab itself when it went to Microsoft's sign-in host: no Teams press there", async () => {
    pages = [{ name: "tab", url: LOGIN_URL, shown: { microsoft: tile } }];
    const a = agent();
    signedOut();
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    later(1);
    await trySignIn(a);
    expect(presses).toEqual(["tab@200,150"]);
    expect(tried().pressed).toEqual(["account"]);
  });

  it("presses nothing on Microsoft's page when it asks for a password or a code, and nothing after", async () => {
    const a = agent();
    signedOut();
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    popup({ microsoft: { asks: true, accounts: 0, account: null, buttons: 0, button: null } });
    await trySignIn(a);
    later(1);
    await trySignIn(a);
    expect(tried()).toMatchObject({ pressed: ["teams"], microsoft: true });
    pages[1].shown.microsoft = tile;
    later(1);
    await trySignIn(a);
    expect(presses).toEqual(["teams@40,12"]);
  });

  it("presses nothing on Microsoft's page where the owner types", async () => {
    const a = agent();
    signedOut();
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    popup({ microsoft: tile });
    await trySignIn(a);
    pages[1].shown.input = [Date.now()];
    later(1);
    await trySignIn(a);
    expect(presses).toEqual(["teams@40,12"]);
    expect(tried()).toMatchObject({ pressed: ["teams"], microsoft: true });
  });

  it("leaves Microsoft's page alone once the attempt is 60 s old", async () => {
    const a = agent();
    signedOut();
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    later(SIGN_IN_TRY_WAIT);
    popup({ microsoft: tile });
    await trySignIn(a);
    later(1);
    await trySignIn(a);
    expect(presses).toEqual(["teams@40,12"]);
  });

  it("tries again in a later sign-out only 30 min after the last attempt", async () => {
    const a = agent();
    signedOut();
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    back();
    later(300);
    signedOut();
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    expect(presses).toEqual(["teams@40,12"]);
    back();
    later(SIGN_IN_TRY_EVERY);
    signedOut();
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    expect(presses).toEqual(["teams@40,12", "teams@40,12"]);
  });

  it("never tries for an account never signed in, nor once the owner was told, nor without a sign-out", async () => {
    const a = agent();
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    signedOut(true);
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    store.setState(STATE.me, "");
    signedOut();
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    expect(presses).toEqual([]);
    expect(tried().at).toBe(0);
  });

  it("presses nothing in Teams without exactly one Sign in, and starts no attempt", async () => {
    pages[0].shown.teams = { asks: true, found: 2, at: null };
    const a = agent();
    signedOut();
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    await trySignIn(a);
    expect(presses).toEqual([]);
    expect(tried().at).toBe(0);
  });

  // prod, slot 2, 2026-09-29 16:13Z: a start of Teams through the proxy of the tenant read as signed out for 20 s, on
  // a Teams page still loading: an attempt began there, pressed nothing and held off the next one for 30 min
  it("starts no attempt while there is neither a Sign in of Teams nor a Microsoft page, as while Teams starts", async () => {
    pages[0].shown.teams = { asks: false, found: 0, at: null };
    const a = agent();
    signedOut();
    later(SIGN_IN_TRY_AFTER + 10);
    await trySignIn(a);
    expect(tried().at).toBe(0);
    // it shows up later in the same sign-out: the attempt starts then
    pages[0].shown.teams = { asks: true, found: 1, at };
    later(5);
    await trySignIn(a);
    expect(presses).toEqual(["teams@40,12"]);
  });

  it("lets an attempt that pressed nothing hold off no later sign-out", async () => {
    pages[0].shown.teams = { asks: false, found: 0, at: null };
    popup({ microsoft: { asks: true, accounts: 0, account: null, buttons: 0, button: null } });
    const a = agent();
    signedOut();
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    later(1);
    await trySignIn(a);
    expect(tried()).toMatchObject({ pressed: [], microsoft: true });
    back();
    pages.pop();
    pages[0].shown.teams = { asks: true, found: 1, at };
    later(300);
    signedOut();
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    expect(presses).toEqual(["teams@40,12"]);
  });

  it("lists what a sign-out shows once it lasts as long as the push waits, when nothing started an attempt", async () => {
    pages[0].shown.teams = { asks: false, found: 0, at: null };
    const info = vi.spyOn(log, "info");
    const a = agent();
    signedOut();
    later(SIGN_IN_TRY_AFTER);
    await trySignIn(a);
    expect(info.mock.calls.filter(([, m]) => m === "sign-in page buttons")).toEqual([]);
    later(60 - SIGN_IN_TRY_AFTER);
    store.setState(STATE.loginWatch, JSON.stringify({ since: Math.floor(Date.now() / 1000) - 60, alerted: true }));
    await trySignIn(a);
    await trySignIn(a);
    expect(info.mock.calls.filter(([, m]) => m === "sign-in page buttons")).toHaveLength(1);
    expect(presses).toEqual([]);
    info.mockRestore();
  });
});
