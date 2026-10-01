import { appDb, browserActionsOf, browserOff, setBrowserOff, slotRow } from "@/lib/appdb";
import { browserHub } from "@/lib/browser-hub";
import { body, HttpError, route } from "@/lib/http";
import { clientName } from "@/lib/mcp/oauth";
import { requireUser } from "@/lib/session";

type Ctx = { params: Promise<{ slot: string }> };

export const dynamic = "force-dynamic";

// The browser of the relay of an account for the MCP clients, as its owner sees it in Settings. The owner only: the
// actions tell which sites were opened.
async function ownSlot(req: Request, param: string) {
  const user = await requireUser(req);
  const n = Number(param);
  const row = Number.isInteger(n) ? slotRow(appDb(), n) : null;
  if (!row || row.owner_id !== user.id) throw new HttpError(404, "Account not found");
  return row;
}

// {off, connected, actions}: switched off in Settings, its relay connected with the browser on, the last 50 calls
export const GET = route<Ctx>(async (req, { params }) => {
  const row = await ownSlot(req, (await params).slot);
  const actions = browserActionsOf(appDb(), row.slot).map((a) => ({ ts: a.ts, client: clientName(a.client_id), tool: a.tool, host: a.host, outcome: a.outcome }));
  return Response.json({ off: browserOff(appDb(), row.slot), connected: !!browserHub()?.tools(row.slot), actions });
});

// {off: true}: the MCP clients get no browser of this account until {off: false}
export const PATCH = route<Ctx>(async (req, { params }) => {
  const row = await ownSlot(req, (await params).slot);
  const { off } = await body(req);
  if (typeof off !== "boolean") throw new HttpError(400, "off must be true or false");
  if (!row.relay) throw new HttpError(409, "Only the relay of an account on another computer has a browser for AI clients");
  setBrowserOff(appDb(), row.slot, off);
  return Response.json({ ok: true, off });
});
