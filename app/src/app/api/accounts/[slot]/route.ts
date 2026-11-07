import { appDb, setCalls } from "@/lib/appdb";
import { config } from "@/lib/config";
import { controlClient } from "@/lib/control";
import { body, HttpError, route } from "@/lib/http";
import { requireAccount } from "@/lib/session";
import { removeAccount, setAccountRunning, setCheckMode, setLightMode } from "@/lib/slots";

type Ctx = { params: Promise<{ slot: string }> };

// Switches the account off ({running: false}) or on again. Stopped, it keeps its Microsoft session and
// data: no sync, no notifications, no commands until it runs again. {checkEvery}: seconds between two checks of an
// account whose browser runs only while it is checked (3600, 7200, 14400), or 0 for always on. {light: true}: no
// browser of its own, its browser runs only to sign it in again (src/lib/light.ts); another mode ends it. {calls}: calls
// of an account with no browser on or off; its light agent starts or stops its calling worker within seconds.
export const PATCH = route<Ctx>(async (req, { params }) => {
  const n = await requireAccount(req, (await params).slot);
  const { running, checkEvery, light, calls } = await body(req);
  if (calls !== undefined) {
    if (typeof calls !== "boolean") throw new HttpError(400, "calls must be true or false");
    setCalls(appDb(), n, calls);
    return Response.json({ ok: true, calls });
  }
  if (light !== undefined) {
    if (light !== true) throw new HttpError(400, "light must be true: choose another mode to end it");
    await setLightMode(n, controlClient(), appDb());
    return Response.json({ ok: true, light });
  }
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
