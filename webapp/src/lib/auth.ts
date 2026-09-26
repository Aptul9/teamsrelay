import { betterAuth, type BetterAuthOptions } from "better-auth";
import { admin } from "better-auth/plugins";
import { appDb } from "./appdb";
import { config } from "./config";

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
