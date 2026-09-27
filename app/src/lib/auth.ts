import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { appDb, forgetFcmDevicesOfSession } from "./appdb";
import { config } from "./config";
import { ENV_PASSWORD_MESSAGE, isEnvAdmin } from "./env-admin";

// The administrator of .env changes its password in .env only, not from Settings nor from Users
const envPasswordGuard = createAuthMiddleware(async (ctx) => {
  let email: string | undefined;
  if (ctx.path === "/change-password") email = (await getSessionFromCtx(ctx))?.user.email;
  else if (ctx.path === "/admin/set-user-password") {
    const userId = (ctx.body as { userId?: unknown } | undefined)?.userId;
    if (typeof userId === "string") email = (await ctx.context.internalAdapter.findUserById(userId))?.email;
  } else return;
  if (isEnvAdmin(email)) throw new APIError("FORBIDDEN", { message: ENV_PASSWORD_MESSAGE });
});

export function authOptions() {
  return {
    appName: "TeamsRelay",
    database: appDb(),
    secret: config.authSecret,
    baseURL: config.appUrl,
    trustedOrigins: [config.appUrl],
    emailAndPassword: {
      enabled: true,
      // users are created by an administrator
      disableSignUp: true,
      minPasswordLength: 10,
      maxPasswordLength: 256,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    plugins: [admin()],
    hooks: { before: envPasswordGuard },
    // a phone of the Android app gets pushes as long as the session that registered it lasts: a lost phone stops with
    // "Sign out every other device" or a password change
    databaseHooks: {
      session: {
        delete: {
          after: async (session) => {
            forgetFcmDevicesOfSession(appDb(), session.id);
          },
        },
      },
    },
  } satisfies BetterAuthOptions;
}

// Created on first use: the build imports route modules without a database or secrets.
const createAuth = () => betterAuth(authOptions());
type Auth = ReturnType<typeof createAuth>;
let instance: Auth | null = null;

export function auth(): Auth {
  instance ??= createAuth();
  return instance;
}
