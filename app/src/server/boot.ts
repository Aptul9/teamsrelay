import { getMigrations } from "better-auth/db/migration";
import { appDb, migrateAppSchema } from "@/lib/appdb";
import { authOptions } from "@/lib/auth";
import { config } from "@/lib/config";
import { controlClient } from "@/lib/control";
import { mcpConfigError } from "@/lib/mcp/access";
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
  keepSlotsUp(controlClient(), appDb());
}
