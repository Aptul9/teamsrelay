import path from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { beforeAll, describe, expect, it } from "vitest";
import { appDb, migrateAppSchema } from "@/lib/appdb";
import { auth, authOptions } from "@/lib/auth";
import { isEnvAdmin } from "@/lib/env-admin";
import { syncEnvAdmin } from "@/server/env-admin";
import { tempDir } from "./helpers";

// appDb() and auth() are created on first use, after this file has set the environment
process.env.APP_DB = path.join(tempDir(), "app.db");
process.env.BETTER_AUTH_SECRET = "test-secret-0123456789-0123456789-0123456789";
process.env.DOMAIN = "http://localhost:8090";
process.env.ADMIN_EMAIL = "Admin@Example.test";
process.env.ADMIN_PASSWORD = "first-password-1";

async function signIn(email: string, password: string): Promise<Headers | null> {
  try {
    const { headers } = await auth().api.signInEmail({ body: { email, password }, returnHeaders: true });
    const cookie = headers.get("set-cookie")?.split(";")[0];
    return cookie ? new Headers({ cookie }) : null;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  const { runMigrations } = await getMigrations(authOptions());
  await runMigrations();
  migrateAppSchema(appDb());
});

describe("administrator of .env", () => {
  it("is created on an empty server and can sign in", async () => {
    expect(await syncEnvAdmin()).toMatch(/created/);
    const users = appDb().prepare('SELECT email, role FROM "user"').all();
    expect(users).toEqual([{ email: "admin@example.test", role: "admin" }]);
    expect(await signIn("admin@example.test", "first-password-1")).not.toBeNull();
  });

  it("is left alone while .env does not change", async () => {
    const session = await signIn("admin@example.test", "first-password-1");
    expect(await syncEnvAdmin()).toMatch(/in line/);
    expect(await auth().api.getSession({ headers: session! })).not.toBeNull();
  });

  it("takes the new password of .env and is signed out everywhere", async () => {
    const session = await signIn("admin@example.test", "first-password-1");
    process.env.ADMIN_PASSWORD = "second-password-2";
    expect(await syncEnvAdmin()).toMatch(/password set from ADMIN_PASSWORD/);
    expect(await signIn("admin@example.test", "first-password-1")).toBeNull();
    expect(await signIn("admin@example.test", "second-password-2")).not.toBeNull();
    expect(await auth().api.getSession({ headers: session! })).toBeNull();
  });

  it("cannot change its password in the app", async () => {
    const session = await signIn("admin@example.test", "second-password-2");
    await expect(
      auth().api.changePassword({ body: { currentPassword: "second-password-2", newPassword: "third-password-3" }, headers: session! }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const admin = appDb().prepare('SELECT id FROM "user" WHERE email = ?').pluck().get("admin@example.test") as string;
    await expect(auth().api.setUserPassword({ body: { userId: admin, newPassword: "third-password-3" }, headers: session! })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await signIn("admin@example.test", "second-password-2")).not.toBeNull();
  });

  it("leaves the other users free to change theirs", async () => {
    await auth().api.createUser({ body: { email: "user@example.test", password: "user-password-1", name: "User", role: "user" } });
    const session = await signIn("user@example.test", "user-password-1");
    await auth().api.changePassword({ body: { currentPassword: "user-password-1", newPassword: "user-password-2" }, headers: session! });
    expect(await signIn("user@example.test", "user-password-2")).not.toBeNull();
  });

  it("is recognised whatever the case of the address", () => {
    expect(isEnvAdmin("ADMIN@example.TEST")).toBe(true);
    expect(isEnvAdmin("user@example.test")).toBe(false);
    expect(isEnvAdmin(null)).toBe(false);
  });
});
