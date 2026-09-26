import { appDb, listSlots } from "@/lib/appdb";
import { auth } from "@/lib/auth";
import { config } from "@/lib/config";
import { body, HttpError, route, text } from "@/lib/http";
import { requireAdmin } from "@/lib/session";

// Users with the slots they own. Administrators see who owns a slot, never its chats.
export const GET = route(async (req) => {
  await requireAdmin(req);
  const { users } = await auth().api.listUsers({ query: { limit: 1000, sortBy: "createdAt" }, headers: req.headers });
  const slots = listSlots(appDb());
  return Response.json({
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role ?? "user",
      banned: !!u.banned,
      createdAt: u.createdAt,
      slots: slots.filter((s) => s.owner_id === u.id).map((s) => s.slot),
    })),
    slotCount: config.slotCount,
    free: Math.max(0, config.slotCount - slots.length),
  });
});

export const POST = route(async (req) => {
  await requireAdmin(req);
  const b = await body(req);
  const role = b.role === "admin" ? "admin" : "user";
  const password = text(b.password, "password", 256);
  if (password.length < 10) throw new HttpError(400, "Password: at least 10 characters");
  const { user } = await auth().api.createUser({
    body: { email: text(b.email, "email", 254).trim(), name: text(b.name, "name", 100).trim(), password, role },
    headers: req.headers,
  });
  return Response.json({ ok: true, id: user.id });
});
