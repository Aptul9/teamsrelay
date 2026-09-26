import { appDb, slotOwner } from "@/lib/appdb";
import { config } from "@/lib/config";
import { dockerClient } from "@/lib/docker";
import { HttpError, route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { removeAccount } from "@/lib/slots";

type Ctx = { params: Promise<{ slot: string }> };

// Like "Sign out" in Teams: stops the slot and deletes its Microsoft session and data.
// The owner, or an administrator freeing a slot.
export const DELETE = route<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const n = Number((await params).slot);
  const owner = Number.isInteger(n) ? slotOwner(appDb(), n) : null;
  if (!owner || (owner !== user.id && user.role !== "admin")) throw new HttpError(404, "Account not found");
  await removeAccount(n, dockerClient(), { db: appDb(), dataDir: config.dataDir, configDir: config.configDir });
  return Response.json({ ok: true });
});
