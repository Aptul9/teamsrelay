import { appDb, slotOwner } from "@/lib/appdb";
import { config } from "@/lib/config";
import { controlClient } from "@/lib/control";
import { body, HttpError, route } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { removeAccount, setAccountRunning } from "@/lib/slots";

type Ctx = { params: Promise<{ slot: string }> };

// The owner, or an administrator freeing or switching off a slot.
async function accountOf(req: Request, params: Ctx["params"]): Promise<number> {
  const user = await requireUser(req);
  const n = Number((await params).slot);
  const owner = Number.isInteger(n) ? slotOwner(appDb(), n) : null;
  if (!owner || (owner !== user.id && user.role !== "admin")) throw new HttpError(404, "Account not found");
  return n;
}

// Switches the account off ({running: false}) or on again. Stopped, it keeps its Microsoft session and
// data: no sync, no notifications, no commands until it runs again.
export const PATCH = route<Ctx>(async (req, { params }) => {
  const n = await accountOf(req, params);
  const { running } = await body(req);
  if (typeof running !== "boolean") throw new HttpError(400, "running must be true or false");
  await setAccountRunning(n, running, controlClient(), appDb());
  return Response.json({ ok: true, running });
});

// Like "Sign out" in Teams: stops the slot and deletes its Microsoft session and data.
export const DELETE = route<Ctx>(async (req, { params }) => {
  const n = await accountOf(req, params);
  await removeAccount(n, controlClient(), { db: appDb(), dataDir: config.dataDir });
  return Response.json({ ok: true });
});
