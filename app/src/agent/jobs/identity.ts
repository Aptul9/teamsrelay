import { Identity, parseState, STATE } from "@/shared/slot-db/state";
import type { Agent } from "../context";
import { errorText, log } from "../log";
import { readIdentity } from "../teams/scripts/page-state";
import { SEL } from "../teams/selectors";

// Who is signed in: name, email and organization of the Microsoft account, with the profile picture and the logo of
// the company
export async function saveIdentity(a: Agent) {
  let read;
  try {
    read = await a.tp.page.evaluate(readIdentity, SEL);
  } catch (e) {
    log.warn("identity", errorText(e));
    return;
  }
  if (!read.email && !read.name) return;
  const old = parseState(Identity, a.store.getState(STATE.me), null);
  const { avsrc, ...who } = read;
  const me: Identity = {
    ...who,
    av: (await a.media.avatar(a.tp.page, avsrc, { left: 1 })) || old?.av || "",
    logo: await a.media.companyLogo(who, (old && old.tenant === who.tenant && old.logo) || "", a.tp.page),
  };
  if (!old || old.name !== me.name || old.email !== me.email || old.tenant !== me.tenant || old.av !== me.av || old.logo !== me.logo) {
    log.info("identity", "account", { email: me.email, tenant: me.tenant, logo: !!me.logo });
  }
  a.store.setState(STATE.me, JSON.stringify(me));
}
