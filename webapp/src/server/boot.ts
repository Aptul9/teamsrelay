import { getMigrations } from "better-auth/db/migration";
import { adoptLegacyData, appDb, migrateAppSchema } from "@/lib/appdb";
import { auth, authOptions } from "@/lib/auth";
import { config } from "@/lib/config";
import { dockerClient } from "@/lib/docker";
import { keepSlotsUp } from "@/lib/slots";

function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

// First start with an empty user table: the administrator comes from ADMIN_EMAIL / ADMIN_PASSWORD and
// takes over the slots and devices of the single-user release.
async function bootstrapAdmin() {
  const db = appDb();
  const users = db.prepare('SELECT COUNT(*) FROM "user"').pluck().get() as number;
  if (users > 0) return;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  // without users nobody can sign in, and the accounts of the previous release would stay unreachable
  if (!email || !password) fatal("No users yet: set ADMIN_EMAIL and ADMIN_PASSWORD in .env to create the first administrator");
  if (password.length < 10) fatal("ADMIN_PASSWORD must be at least 10 characters");
  const { user } = await auth().api.createUser({
    body: { email, password, name: process.env.ADMIN_NAME || "Administrator", role: "admin" },
  });
  const moved = adoptLegacyData(db, user.id);
  console.log(`administrator ${user.email} created, ${moved.slots} existing accounts and ${moved.devices} devices assigned`);
}

export async function boot() {
  if (config.authSecret.length < 32) fatal("BETTER_AUTH_SECRET must be set, at least 32 characters (openssl rand -hex 32)");
  // tables first: better-auth checks its schema when the instance is created
  const { runMigrations } = await getMigrations(authOptions());
  await runMigrations();
  migrateAppSchema(appDb());
  await bootstrapAdmin();
  if (config.dockerApi) keepSlotsUp(dockerClient(), appDb());
  else console.warn("DOCKER_API not set: accounts cannot be switched on or off");
}
