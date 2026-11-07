import { Identity, LightSignIn, parseState, STATE } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { LightToken } from "../light/token";
import { SessionAuth, sessionFile, TEAMS_WEB_CLIENT } from "../light/session-auth";
import { errorText, log } from "../log";
import { regionOf } from "../teams/chatsvc";
import { readMsalEntries, type MsalEntry } from "../teams/scripts/tokens";

export { TEAMS_WEB_CLIENT } from "../light/session-auth";

// Without an expiry in the page, the refresh token of a single-page app is taken to hold this long (Microsoft: 24 h)
const ASSUMED_LIFE = 20 * 3600;

// The refresh token of Teams web among those the page keeps, else the first one
export const teamsRefreshToken = (entries: readonly MsalEntry[]): MsalEntry | null => entries.find((e) => e.clientId === TEAMS_WEB_CLIENT) ?? entries[0] ?? null;

// Capture the refresh token and Microsoft session for the light agent. Existing accounts can supply their saved
// token before Teams loads; session cookies then let the light agent renew it over HTTP.
export async function captureLightToken(a: Agent): Promise<boolean> {
  const file = a.config.lightTokenFile;
  if (!file) return false;
  try {
    const previous = LightToken.load(file);
    const rt = teamsRefreshToken(await a.tp.page.evaluate(readMsalEntries, ["refreshtoken"]).catch(() => []));
    const tenantId = rt?.homeAccountId.split(".")[1] || previous?.tenantId || "";
    if ((!rt && !previous) || !tenantId) return false;
    const unchanged = !rt || previous?.refreshToken === rt.secret;
    if (unchanged && SessionAuth.load(sessionFile(file))) return false;
    const now = nowSeconds();
    // An expired SPA token still carries the tenant/client needed for HTTP renewal.
    const expiresOn = rt ? rt.expiresOn || now + ASSUMED_LIFE : previous!.expiresOn;
    const cookies = await a.tp.page.context().cookies();
    const region = regionOf(cookies);
    const microsoft = cookies.filter((c) => /^\.?login\.microsoftonline\.com$/i.test(c.domain));
    if (microsoft.some((c) => /^ESTSAUTH(?:PERSISTENT|LIGHT)?$/i.test(c.name))) {
      SessionAuth.save(sessionFile(file), { cookies: microsoft, userAgent: await a.tp.page.evaluate(() => navigator.userAgent), loginHint: parseState(Identity, a.store.getState(STATE.me)).email });
    } else if (unchanged) return false;
    LightToken.save(file, { refreshToken: rt?.secret ?? previous!.refreshToken, clientId: rt?.clientId ?? previous!.clientId, tenantId, region: rt ? region : previous!.region, expiresOn });
    const session = !!SessionAuth.load(sessionFile(file));
    a.store.setState(STATE.lightToken, JSON.stringify({ at: now, expiresOn, refused: false, ...(session ? { session } : {}) } satisfies LightSignIn));
    log.info("light", "sign-in captured", { until: new Date(expiresOn * 1000).toISOString() });
    return true;
  } catch (e) {
    log.warn("light", `capture: ${errorText(e)}`);
    return false;
  }
}

// The sign-in the light agent runs on, as the state row says it
export const lightSignIn = (a: Pick<Agent, "store">) => parseState(LightSignIn, a.store.getState(STATE.lightToken));
