import { mcp } from "@better-auth/mcp";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin, jwt } from "better-auth/plugins";
import { appDb, forgetFcmDevicesOfSession } from "./appdb";
import { config } from "./config";
import { ENV_PASSWORD_MESSAGE, isEnvAdmin } from "./env-admin";
import { mcpResource, nativeByDefault } from "./mcp/oauth";

// Before every request of better-auth. The administrator of .env changes its password in .env only, not from Settings
// nor from Users. An MCP client registering itself with a loopback redirect and no application_type (MCP SDK 1.x) is a
// native app: better-auth would take it for a web client, which may not use an http://localhost redirect.
const before = createAuthMiddleware(async (ctx) => {
  if (ctx.path === "/oauth2/register") {
    const body = nativeByDefault(ctx.body);
    return body === ctx.body ? undefined : { context: { body } };
  }
  let email: string | undefined;
  if (ctx.path === "/change-password") email = (await getSessionFromCtx(ctx))?.user.email;
  else if (ctx.path === "/admin/set-user-password") {
    const userId = (ctx.body as { userId?: unknown } | undefined)?.userId;
    if (typeof userId === "string") email = (await ctx.context.internalAdapter.findUserById(userId))?.email;
  } else return;
  if (isEnvAdmin(email)) throw new APIError("FORBIDDEN", { message: ENV_PASSWORD_MESSAGE });
});

// OAuth 2.1 for MCP clients (@better-auth/mcp, docs/mcp.md): tokens for /mcp, signed by the jwt plugin, given after the
// sign-in of this app and a consent screen; clients register themselves. Off when the address of the app is plain HTTP
// on a host other than this computer's, which the MCP resource may not be.
function oauthPlugins() {
  const resource = mcpResource();
  if (!resource) return [];
  return [
    jwt(),
    mcp({
      loginPage: "/login",
      consentPage: "/consent",
      resource,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
    }),
  ];
}

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
    plugins: [admin(), ...oauthPlugins()],
    hooks: { before },
    // a phone of the Android app gets pushes as long as the session that registered it lasts: a lost phone stops with
    // "Sign out every other device" or a password change
    databaseHooks: {
      session: {
        delete: {
          after: async (session) => {
            // a failure here must not fail the sign-out or the password change that ended the session
            try {
              forgetFcmDevicesOfSession(appDb(), session.id);
            } catch (e) {
              console.error(`phones of session: ${e instanceof Error ? e.message : String(e)}`);
            }
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
