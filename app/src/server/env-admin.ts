import { adoptLegacyData, appDb } from "@/lib/appdb";
import { auth } from "@/lib/auth";
import { envAdminEmail } from "@/lib/env-admin";
import { PASSWORD_MIN } from "@/shared/password";

// The administrator of .env exists, is an administrator, is not banned and signs in with ADMIN_PASSWORD.
// A new password in .env signs it out of every device. Returns what was done, for the log.
export async function syncEnvAdmin(): Promise<string> {
  const db = appDb();
  const users = db.prepare('SELECT COUNT(*) FROM "user"').pluck().get() as number;
  const email = envAdminEmail();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || !password) {
    // without users nobody can sign in, and the accounts of the previous release would stay unreachable
    if (!users) throw new Error("No users yet: set ADMIN_EMAIL and ADMIN_PASSWORD in .env to create the first administrator");
    return "no administrator in .env";
  }
  if (password.length < PASSWORD_MIN) throw new Error(`ADMIN_PASSWORD must be at least ${PASSWORD_MIN} characters`);

  const ctx = await auth().$context;
  const found = await ctx.internalAdapter.findUserByEmail(email, { includeAccounts: true });
  if (!found) {
    const { user } = await auth().api.createUser({
      body: { email, password, name: process.env.ADMIN_NAME || "Administrator", role: "admin" },
    });
    if (users) return `administrator ${email} created`;
    // first user of a server upgraded from the single-user release: it takes over its slots and devices
    const moved = adoptLegacyData(db, user.id);
    return `administrator ${email} created, ${moved.slots} existing accounts and ${moved.devices} devices assigned`;
  }

  const done: string[] = [];
  const u = found.user as typeof found.user & { role?: string | null; banned?: boolean | null };
  if (u.role !== "admin" || u.banned) {
    await ctx.internalAdapter.updateUser(u.id, { role: "admin", banned: false, banReason: null, banExpires: null });
    done.push("administrator rights restored");
  }
  const credential = found.accounts.find((a) => a.providerId === "credential");
  if (!credential?.password || !(await ctx.password.verify({ hash: credential.password, password }))) {
    const hash = await ctx.password.hash(password);
    if (credential) await ctx.internalAdapter.updatePassword(u.id, hash);
    else await ctx.internalAdapter.linkAccount({ userId: u.id, providerId: "credential", accountId: u.id, password: hash });
    await ctx.internalAdapter.deleteUserSessions(u.id);
    done.push("password set from ADMIN_PASSWORD, signed out everywhere");
  }
  return `administrator ${email}: ${done.length ? done.join(", ") : "in line with .env"}`;
}
