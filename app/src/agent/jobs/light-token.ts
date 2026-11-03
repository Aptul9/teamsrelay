import { LightSignIn, parseState, STATE } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { LightToken } from "../light/token";
import { errorText, log } from "../log";
import { regionOf } from "../teams/chatsvc";
import { readMsalEntries, type MsalEntry } from "../teams/scripts/tokens";

// Client id of Teams web, whose refresh token a light account runs on
export const TEAMS_WEB_CLIENT = "5e3ce6c0-2b1f-4285-8d4b-75ee78787346";

// Without an expiry in the page, the refresh token of a single-page app is taken to hold this long (Microsoft: 24 h)
const ASSUMED_LIFE = 20 * 3600;

// The refresh token of Teams web among those the page keeps, else the first one
export const teamsRefreshToken = (entries: readonly MsalEntry[]): MsalEntry | null => entries.find((e) => e.clientId === TEAMS_WEB_CLIENT) ?? entries[0] ?? null;

// The browser of a light account runs to sign it in again (src/lib/light.ts): the refresh token Teams web keeps goes to
// data/N/light-token.json for the light agent, and its expiry to the state row the web app watches. Only a token other
// than the one stored is written.
export async function captureLightToken(a: Agent): Promise<boolean> {
  const file = a.config.lightTokenFile;
  if (!file) return false;
  try {
    const rt = teamsRefreshToken(await a.tp.page.evaluate(readMsalEntries, ["refreshtoken"]));
    const tenantId = rt?.homeAccountId.split(".")[1] ?? "";
    if (!rt || !tenantId) return false;
    if (LightToken.load(file)?.refreshToken === rt.secret) return false;
    const now = nowSeconds();
    // one already ended is stored too: the web app waits for the one Teams renews it with (src/lib/light.ts)
    const expiresOn = rt.expiresOn || now + ASSUMED_LIFE;
    const region = regionOf(await a.tp.page.context().cookies());
    LightToken.save(file, { refreshToken: rt.secret, clientId: rt.clientId, tenantId, region, expiresOn });
    a.store.setState(STATE.lightToken, JSON.stringify({ at: now, expiresOn, refused: false } satisfies LightSignIn));
    log.info("light", "sign-in captured", { until: new Date(expiresOn * 1000).toISOString() });
    return true;
  } catch (e) {
    log.warn("light", `capture: ${errorText(e)}`);
    return false;
  }
}

// The sign-in the light agent runs on, as the state row says it
export const lightSignIn = (a: Pick<Agent, "store">) => parseState(LightSignIn, a.store.getState(STATE.lightToken));
