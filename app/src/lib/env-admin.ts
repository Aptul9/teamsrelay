// The administrator of .env (ADMIN_EMAIL, ADMIN_PASSWORD) is brought in line with .env at every start
// (src/server/env-admin.ts): its password changes in .env, never in the app.
export const ENV_PASSWORD_MESSAGE = "The password of this administrator is set by ADMIN_PASSWORD in .env";

export function envAdminEmail(): string {
  return (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
}

export function isEnvAdmin(email: string | null | undefined): boolean {
  const env = envAdminEmail();
  return !!env && (email || "").trim().toLowerCase() === env;
}
