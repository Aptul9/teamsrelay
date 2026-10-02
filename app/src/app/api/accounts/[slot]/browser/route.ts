import { appDb, browserActionsOf, setBrowserOff } from "@/lib/appdb";
import { browserHub } from "@/lib/browser-hub";
import { body, HttpError, route } from "@/lib/http";
import { clientName } from "@/lib/mcp/oauth";
import { ownedSlot } from "@/lib/authz";
import { requireUser } from "@/lib/session";

type Ctx = { params: Promise<{ slot: string }> };

export const dynamic = "force-dynamic";

// The browser of the relay of an account for the MCP clients, as its owner sees it in Settings. The owner only: the
// actions tell which sites were opened.
async function ownSlot(req: Request, param: string) {
  return ownedSlot((await requireUser(req)).id, param);
}

// {off, connected, actions}: switched off in Settings, its relay connected with the browser on, the last 50 calls
export const GET = route<Ctx>(async (req, { params }) => {
  const row = await ownSlot(req, (await params).slot);
  const actions = browserActionsOf(appDb(), row.slot).map((a) => ({ ts: a.ts, client: clientName(a.client_id), tool: a.tool, host: a.host, outcome: a.outcome }));
  return Response.json({ off: !!row.browser_off, connected: !!browserHub()?.tools(row.slot), actions });
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
