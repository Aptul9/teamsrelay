// A phone of the Android app gets the pushes of its user as long as the session that registered it lasts: signed out,
// or signed out by "Sign out every other device" or a password change elsewhere (a lost phone), it gets nothing more
import path from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/push/fcm/route";
import { appDb, migrateAppSchema } from "@/lib/appdb";
import { auth, authOptions } from "@/lib/auth";
import { syncEnvAdmin } from "@/server/env-admin";
import { tempDir } from "./helpers";

// appDb() and auth() are created on first use, after this file has set the environment
process.env.APP_DB = path.join(tempDir(), "app.db");
process.env.BETTER_AUTH_SECRET = "test-secret-0123456789-0123456789-0123456789";
process.env.DOMAIN = "http://localhost:8090";
process.env.ADMIN_EMAIL = "admin@example.test";
process.env.ADMIN_PASSWORD = "first-password-1";

async function signIn(): Promise<Headers> {
  const { headers } = await auth().api.signInEmail({ body: { email: "admin@example.test", password: "first-password-1" }, returnHeaders: true });
  return new Headers({ cookie: headers.get("set-cookie")!.split(";")[0] });
}

const register = (session: Headers, token: string) =>
  POST(
    new Request("http://localhost:8090/api/push/fcm", {
      method: "POST",
      body: JSON.stringify({ token, name: "Google Pixel 9" }),
      headers: { "Content-Type": "application/json", cookie: session.get("cookie")! },
    }),
    undefined,
  );

const phones = () => appDb().prepare("SELECT endpoint FROM push_subscriptions ORDER BY endpoint").pluck().all();

beforeAll(async () => {
  const { runMigrations } = await getMigrations(authOptions());
  await runMigrations();
  migrateAppSchema(appDb());
  await syncEnvAdmin();
});

describe("a phone of the Android app", () => {
  it("is forgotten when another device signs out every other device, the phone included", async () => {
    const phone = await signIn();
    const pc = await signIn();
    expect((await register(phone, "phone-token-aaaaaaaaaaaaaaaaaaaa")).status).toBe(200);
    expect(phones()).toEqual(["fcm:phone-token-aaaaaaaaaaaaaaaaaaaa"]);
    await auth().api.revokeOtherSessions({ headers: pc });
    expect(phones()).toEqual([]);
  });

  it("is forgotten when its own session signs out, and the phones of other sessions stay", async () => {
    const one = await signIn();
    const two = await signIn();
    await register(one, "phone-token-bbbbbbbbbbbbbbbbbbbb");
    await register(two, "phone-token-cccccccccccccccccccc");
    await auth().api.signOut({ headers: one });
    expect(phones()).toEqual(["fcm:phone-token-cccccccccccccccccccc"]);
  });
});
