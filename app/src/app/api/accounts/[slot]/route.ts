import { appDb } from "@/lib/appdb";
import { config } from "@/lib/config";
import { controlClient } from "@/lib/control";
import { body, HttpError, route } from "@/lib/http";
import { requireAccount } from "@/lib/session";
import { removeAccount, setAccountRunning, setCheckMode } from "@/lib/slots";

type Ctx = { params: Promise<{ slot: string }> };

// Switches the account off ({running: false}) or on again. Stopped, it keeps its Microsoft session and
// data: no sync, no notifications, no commands until it runs again. {checkEvery}: seconds between two checks of an
// account whose browser runs only while it is checked (3600, 7200, 14400), or 0 for always on.
export const PATCH = route<Ctx>(async (req, { params }) => {
  const n = await requireAccount(req, (await params).slot);
  const { running, checkEvery } = await body(req);
  if (checkEvery !== undefined) {
    if (typeof checkEvery !== "number") throw new HttpError(400, "checkEvery must be a number of seconds");
    await setCheckMode(n, checkEvery, controlClient(), appDb());
    return Response.json({ ok: true, checkEvery });
  }
  if (typeof running !== "boolean") throw new HttpError(400, "running must be true or false");
  await setAccountRunning(n, running, controlClient(), appDb());
  return Response.json({ ok: true, running });
});

// Like "Sign out" in Teams: stops the slot and deletes its Microsoft session and data.
export const DELETE = route<Ctx>(async (req, { params }) => {
  const n = await requireAccount(req, (await params).slot);
  await removeAccount(n, controlClient(), { db: appDb(), dataDir: config.dataDir });
  return Response.json({ ok: true });
});
