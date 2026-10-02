import { idleReason, queue } from "@/lib/commands";
import { chatName } from "@/shared/command-input";
import { body, route } from "@/lib/http";
import { requireSlot } from "@/lib/session";
import { withSlot } from "@/lib/slotdb";

// Names older than this are read again from Teams
const MEMBERS_MAX_AGE = 3600;

// {name}: the people of a chat, for the @ of the compose box. The names the agent read last come at once; when they
// are older than an hour the agent reads them again, and id is that command, to follow before asking again.
export const POST = route(async (req) => {
  const { slot } = await requireSlot(req);
  const name = chatName((await body(req)).name);
  const { ts, names: all, pending, me } = withSlot(slot, (r) => ({ ...r.members(name), pending: r.pendingCommand("members", name), me: r.identity().name }));
  // Teams never lists you among the people to tag
  const names = all.filter((n) => n !== me);
  if (Date.now() / 1000 - ts < MEMBERS_MAX_AGE || idleReason(slot)) return Response.json({ names });
  return Response.json({ names, id: pending || queue(slot, "members", name) });
});
