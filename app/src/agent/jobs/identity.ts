import { Identity, parseState, STATE } from "@/shared/slot-db/state";
import type { Agent } from "../context";
import { errorText, log } from "../log";
import { readIdentity } from "../teams/scripts/page-state";
import { SEL } from "../teams/selectors";

// Who is signed in: name, email and organization of the Microsoft account, with the profile picture
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
  const me: Identity = { ...who, av: (await a.media.avatar(a.tp.page, avsrc, { left: 1 })) || old?.av || "" };
  if (!old || old.name !== me.name || old.email !== me.email || old.tenant !== me.tenant || old.av !== me.av) {
    log.info("identity", "account", { email: me.email, tenant: me.tenant });
  }
  a.store.setState(STATE.me, JSON.stringify(me));
}
