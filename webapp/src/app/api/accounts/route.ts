import { accountsOf } from "@/lib/accounts";
import { appDb } from "@/lib/appdb";
import { config, desktopUrlOf } from "@/lib/config";
import { dockerClient } from "@/lib/docker";
import { route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { addAccount } from "@/lib/slots";

export const GET = route(async (req) => {
  const user = await requireUser(req);
  return Response.json(accountsOf(user.id));
});

// New Teams account: first free slot, wiped, browser and agent started. The Microsoft login happens
// afterwards in the remote desktop of the slot.
export const POST = route(async (req) => {
  const user = await requireUser(req);
  const slot = await addAccount(user.id, dockerClient(), {
    db: appDb(),
    dataDir: config.dataDir,
    configDir: config.configDir,
    slotCount: config.slotCount,
    perUser: config.accountsPerUser,
  });
  return Response.json({ ok: true, slot, desktop: desktopUrlOf(slot) });
});
