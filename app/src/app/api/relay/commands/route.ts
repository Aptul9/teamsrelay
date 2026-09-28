import { appDb, countPushSubscriptions, slotOwner } from "@/lib/appdb";
import { route } from "@/lib/http";
import { requireRelay, waitForRelayCommands } from "@/lib/relay";
import { COMMANDS_WAIT_MS, type CommandsAnswer } from "@/shared/relay-sync";

export const dynamic = "force-dynamic";

const count = (v: string | null) => Math.max(0, Math.floor(Number(v) || 0));

// The commands the app queued for the account after ?after=<id>, and the chat it shows when newer than ?vts=<ts>:
// at once when there are any, otherwise as soon as some come, at the latest after 25 s with nothing (?wait=0: at once,
// for a relay that starts and learns the series of the account)
export const GET = route(async (req) => {
  const caller = requireRelay(req);
  const url = new URL(req.url);
  const r = await waitForRelayCommands(caller, {
    after: count(url.searchParams.get("after")),
    vts: count(url.searchParams.get("vts")),
    waitMs: url.searchParams.get("wait") === "0" ? 0 : COMMANDS_WAIT_MS,
    signal: req.signal,
  });
  const owner = slotOwner(appDb(), caller.slot);
  const answer: CommandsAnswer = { added: caller.added, ...r, devices: owner ? countPushSubscriptions(appDb(), owner) : 0 };
  return Response.json(answer);
});
