import { nowSeconds } from "@/agent/context";
import { accountSummary } from "@/lib/accounts";
import { appDb, slotRow, slotsOf } from "@/lib/appdb";
import { body, HttpError, route, text } from "@/lib/http";
import { requireAdmin } from "@/lib/session";
import { withSlotOr } from "@/lib/slotdb";
import { addStatusPage, deleteStatusPage, listStatusPages, purgeEndedPages, serverZone, setStatusPageEnds, slugProblem, statusDb, statusPageOf, type StatusPage } from "@/lib/status-pages";
import { dayStart, nextDay } from "@/lib/status-stats";
import { STATE, StatusNames } from "@/shared/slot-db/state";
import { newestOf } from "@/shared/status-db";

// The status pages for the admin card (src/components/StatusPagesCard.tsx): each with whether its account collects
// and why not, the last status seen; the accounts of the administrator a page can collect from

const identityOf = (slot: number) => withSlotOr(slot, (r) => ({ me: r.identity(), names: StatusNames.parse(r.state<unknown>(STATE.statusNames, {})) }), null);

function why(p: StatusPage, now: number): { tenant: string; reason: string } {
  const row = slotRow(appDb(), p.slot);
  const slot = row ? identityOf(p.slot) : null;
  const tenant = slot?.me.tenant || `account ${p.slot}`;
  if (p.ends && p.ends <= now) return { tenant, reason: "challenge ended" };
  if (!row) return { tenant, reason: "account removed" };
  if (!row.light) return { tenant, reason: "account not light" };
  if (row.stopped) return { tenant, reason: "account stopped" };
  if (accountSummary(row).teams === "login") return { tenant, reason: "account signed out" };
  const mri = slot?.names[p.name];
  if (mri === undefined) return { tenant, reason: "waiting for the agent" };
  if (!mri) return { tenant, reason: `not found in ${tenant}` };
  return { tenant, reason: "" };
}

export const GET = route(async (req) => {
  const admin = await requireAdmin(req);
  const now = nowSeconds();
  const sdb = statusDb();
  purgeEndedPages(appDb(), sdb, now);
  const pages = listStatusPages(appDb()).map((p) => {
    const { tenant, reason } = why(p, now);
    return { ...p, tenant, collecting: !reason, reason, last: newestOf(sdb, p.name) };
  });
  const accounts = slotsOf(appDb(), admin.id).map((s) => {
    const me = identityOf(s.slot)?.me;
    return { slot: s.slot, label: me?.name ? `${me.name}${me.tenant ? ` (${me.tenant})` : ""}` : `Account ${s.slot}`, light: !!s.light };
  });
  return Response.json({ pages, accounts });
});

export const POST = route(async (req) => {
  const admin = await requireAdmin(req);
  const b = await body(req);
  const slug = text(b.slug, "slug", 64);
  const problem = slugProblem(appDb(), slug);
  if (problem) throw new HttpError(problem.status, problem.reason);
  const slot = Number(b.slot);
  if (!slotsOf(appDb(), admin.id).some((s) => s.slot === slot && s.light)) throw new HttpError(400, `Account ${b.slot} is not a light account of yours`);
  const name = text(b.name, "name", 100).trim();
  if (!name) throw new HttpError(400, "Missing name");
  addStatusPage(appDb(), { slug, slot, name, added: nowSeconds(), ends: 0 });
  return Response.json({ ok: true });
});

// ends: the last day of the challenge (YYYY-MM-DD, it ends at the midnight after), "" for none
export const PATCH = route(async (req) => {
  await requireAdmin(req);
  const b = await body(req);
  const slug = text(b.slug, "slug", 64);
  const day = text(b.ends, "ends", 10);
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, "End date: YYYY-MM-DD");
  const ends = day ? dayStart(nextDay(day), serverZone()) : 0;
  if (!statusPageOf(appDb(), slug) || !setStatusPageEnds(appDb(), slug, ends)) throw new HttpError(404, "Page not found");
  return Response.json({ ok: true, ends });
});

export const DELETE = route(async (req) => {
  await requireAdmin(req);
  const b = await body(req);
  if (!deleteStatusPage(appDb(), statusDb(), text(b.slug, "slug", 64))) throw new HttpError(404, "Page not found");
  return Response.json({ ok: true });
});
