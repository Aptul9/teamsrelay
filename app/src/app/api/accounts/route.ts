import { accountsOf } from "@/lib/accounts";
import { appDb } from "@/lib/appdb";
import { config, desktopUrlOf } from "@/lib/config";
import { controlClient } from "@/lib/control";
import { route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { addAccount, addRelayAccount } from "@/lib/slots";

export const GET = route(async (req) => {
  const user = await requireUser(req);
  return Response.json(accountsOf(user.id));
});

// New Teams account: first free slot, wiped, browser and agent started. The Microsoft login happens
// afterwards in the remote desktop of the slot. {relay: true}: an account on another computer, whose local relay
// joins with the token of the answer, shown this once.
export const POST = route(async (req) => {
  const user = await requireUser(req);
  const b = (await req.json().catch(() => ({}))) as { relay?: unknown };
  const o = { db: appDb(), dataDir: config.dataDir, slotCount: config.slotCount, perUser: config.accountsPerUser };
  if (b?.relay === true) {
    const { slot, token } = await addRelayAccount(user.id, o);
    return Response.json({ ok: true, slot, token, server: config.appUrl });
  }
  const slot = await addAccount(user.id, controlClient(), o);
  return Response.json({ ok: true, slot, desktop: desktopUrlOf(slot) });
});
