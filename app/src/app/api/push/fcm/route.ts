import { appDb, forgetFcmDevice, saveFcmDevice } from "@/lib/appdb";
import { body, HttpError, route, text } from "@/lib/http";
import { requireSession } from "@/lib/session";

// The TeamsRelay app for Android (mobile/) registers its phone here, with the session cookie of its web page: the
// relay then sends it the notifications of every Teams account of the user through Firebase, sealed with the key it
// answers (src/agent/push/fcm.ts), for as long as that session lasts (src/lib/auth.ts).
export const POST = route(async (req) => {
  const { user, session } = await requireSession(req);
  const b = await body<{ token?: unknown; name?: unknown }>(req);
  const name = typeof b.name === "string" ? b.name.slice(0, 80) : "";
  return Response.json({ key: saveFcmDevice(appDb(), user.id, fcmToken(b.token), name, session) });
});

// The app forgets its phone once its web page has no session any more (signed out): the token is the proof
export const DELETE = route(async (req) => {
  const b = await body<{ token?: unknown }>(req);
  forgetFcmDevice(appDb(), fcmToken(b.token));
  return Response.json({ ok: true });
});

// An FCM registration token: letters, digits, - _ :, about 160 of them
function fcmToken(v: unknown): string {
  const t = text(v, "token", 4096);
  if (!/^[\w:-]{20,}$/.test(t)) throw new HttpError(400, "Not an FCM token");
  return t;
}
