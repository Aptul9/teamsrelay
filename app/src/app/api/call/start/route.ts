import { appDb, slotRow } from "@/lib/appdb";
import { chatName, queueOnce } from "@/lib/commands";
import { desktopUrlOf } from "@/lib/config";
import { body, HttpError, route } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import { withSlot } from "@/lib/slotdb";
import { inCallOf, ringingCall } from "@/shared/slot-db/state";

const SELF_CHAT = /\(you\)/i;

// {name}: a Teams audio call to the person of that 1:1 chat, while no call rings or runs on the account. The agent opens
// the chat in Teams and places the call at its next round; the sound comes to the app, which starts it with the tap,
// or goes through the remote desktop of the account. An account on another computer has none: its relay runs the
// command in the Teams window there, where the sound stays.
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const b = await body(req);
  const name = chatName(b.name);
  const now = Date.now();
  const { busy, kind } = withSlot(slot, (r) => ({
    busy: !!ringingCall(r.call(), now) || !!inCallOf(r.inCall(), now),
    kind: r.chats().find((c) => c.name === name)?.kind ?? "",
  }));
  if (busy) throw new HttpError(409, "A call is on: end it first");
  if (kind !== "one" || SELF_CHAT.test(name)) throw new HttpError(409, "Only a 1:1 chat can be called");
  const relay = !!slotRow(appDb(), slot)?.relay;
  // audio: the page opened the sound of the call; the relay of an account on another computer then sends it there
  const id = queueOnce(slot, "call", name, relay && b.audio === true ? JSON.stringify({ audio: true }) : "");
  return Response.json({ ok: true, id, desktop: relay ? null : desktopUrlOf(slot) });
});
