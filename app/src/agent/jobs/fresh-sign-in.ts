import { SIGN_IN_TRY_EVERY } from "@/shared/sign-in";
import { Identity, parseState, STATE } from "@/shared/slot-db/state";
import { nowSeconds, type Agent } from "../context";
import { isTeamsUrl } from "../logic/hosts";
import { behindMcas } from "../logic/files";
import { LightToken } from "../light/token";
import { errorText, log } from "../log";
import { readMsalEntries } from "../teams/scripts/tokens";
import { TEAMS_HOSTS } from "../teams/selectors";
import { lightSignIn, teamsRefreshToken } from "./light-token";

// A sign-in holding less than this many seconds is the one to replace (MIN_LIFE of src/lib/light.ts)
const ENDING = 600;

// The browser of a light account runs because its sign-in ended or Microsoft refused it. Teams web in that browser holds
// the same refresh token, so it only shows "We need you to sign in again": its Sign in renews the access tokens
// silently, keeps no refresh token, and Teams signs out again a minute later (Aubay, 2026-11-05). Instead, once per
// SIGN_IN_TRY_EVERY seconds (an agent started again within the same run must not undo a sign-in just done): the data of
// Teams cleared and Teams opened again, which sends the tab to Microsoft's sign-in page as a first sign-in does. The
// session of the browser signs in there by itself, or the page asks the owner on the remote desktop; Teams then keeps a
// new refresh token for the light agent. True when Teams was sent there.
export async function freshSignIn(a: Agent): Promise<boolean> {
  const now = nowSeconds();
  const sign = lightSignIn(a);
  const browser = sign.browser || sign.mcas || behindMcas(a.tp.page.url());
  if (sign.at && !sign.refused && ((sign.session && !browser) || sign.expiresOn - now >= ENDING)) return false;
  const email = a.store.getState(STATE.me) ? parseState(Identity, a.store.getState(STATE.me)).email : "";
  if (!email) return false;
  if (now - (Number(a.store.getState(STATE.freshSignIn)) || 0) < SIGN_IN_TRY_EVERY) return false;
  const page = a.tp.page;
  // a refresh token other than the stored one is a new sign-in already: the light-token job takes it
  const rt = teamsRefreshToken(await page.evaluate(readMsalEntries, ["refreshtoken"]).catch(() => []));
  if (!browser && rt && rt.secret !== (a.config.lightTokenFile && LightToken.load(a.config.lightTokenFile)?.refreshToken)) return false;
  a.store.setState(STATE.freshSignIn, String(now));
  const here = isTeamsUrl(page.url()) ? new URL(page.url()).origin : "https://teams.cloud.microsoft";
  try {
    const cdp = await page.context().newCDPSession(page);
    const proxyOrigins = browser ? ["https://teams.microsoft.com.mcas.ms", "https://teams.cloud.microsoft.mcas.ms"] : [];
    for (const origin of new Set([here, ...TEAMS_HOSTS.map((h) => `https://${h}`), ...proxyOrigins])) {
      await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "local_storage,indexeddb,cache_storage,service_workers" });
    }
    await cdp.detach();
    await page.goto(`${here}/?loginHint=${encodeURIComponent(email)}`, { waitUntil: "commit", timeout: 30_000 });
    log.info("SESSION", "light sign-in: Teams data cleared, Teams sent to a new Microsoft sign-in");
    return true;
  } catch (e) {
    log.warn("SESSION", `light sign-in: ${errorText(e)}`);
    return false;
  }
}
