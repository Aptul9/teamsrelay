import { getMigrations } from "better-auth/db/migration";
import { loadServiceAccount } from "@/agent/push/fcm";
import { appDb, migrateAppSchema } from "@/lib/appdb";
import { authOptions } from "@/lib/auth";
import { config } from "@/lib/config";
import { controlClient } from "@/lib/control";
import { mcpConfigError } from "@/lib/mcp/access";
import { runChecks, settleChecks, slotPort } from "@/lib/checks";
import { keepSlotsUp } from "@/lib/slots";
import { syncEnvAdmin } from "./env-admin";

function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

export async function boot() {
  if (config.authSecret.length < 32) fatal("BETTER_AUTH_SECRET must be set, at least 32 characters (openssl rand -hex 32)");
  const mcp = mcpConfigError();
  if (mcp) fatal(mcp);
  // tables first: better-auth checks its schema when the instance is created
  const { runMigrations } = await getMigrations(authOptions());
  await runMigrations();
  migrateAppSchema(appDb());
  try {
    console.log(await syncEnvAdmin());
  } catch (e) {
    fatal(e instanceof Error ? e.message : String(e));
  }
  if (config.mcpToken) console.log("MCP endpoint on: /mcp");
  let push: typeof config.push;
  try {
    push = config.push;
  } catch (e) {
    fatal(`configuration: ${e instanceof Error ? e.message : String(e)}`);
  }
  // the phones of the Android app get the notifications of the accounts on another computer from here (lib/relay.ts)
  try {
    if (loadServiceAccount(push.fcmCredentials)) console.log("FCM on: phones of the Android app");
  } catch (e) {
    console.error(`FCM off: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ctl = controlClient();
  // a check cut by the restart left its browser running: stopped first, through the same queue
  void settleChecks(ctl, appDb());
  keepSlotsUp(ctl, appDb());
  runChecks({ ctl, db: appDb(), slot: slotPort() });
}
