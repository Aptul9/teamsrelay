// cmdapi entry: node dist/cmdapi.cjs. Config is read once here, so a bad posture fails loudly at startup instead of on
// the first request, and the resolved posture is printed (loopback or not, token or not, which shell). Runs on each
// relay host under pm2 next to the relay; reached from the hub VM through the reverse tunnel.
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "@/agent/config";
import { loadCmdApiConfig } from "./config";
import { startCmdApi, type CmdApiServer } from "./server";

async function main(): Promise<void> {
  // relay.env next to package.json (pm2 starts cmdapi from app/); the process environment wins. Same file as the relay:
  // cmdapi and the relay run side by side on the host.
  if (fs.existsSync("relay.env")) process.loadEnvFile("relay.env");
  const config = loadCmdApiConfig();

  const reach = config.isLoopback ? "loopback only" : "OFF-LOOPBACK, reachable off this machine";
  const guard = config.token ? "token" : "NO TOKEN";
  console.log(`cmdapi: ${config.host}:${config.port}  [${reach}, ${guard}, shell=${path.basename(config.shell)}, cwd=${config.cwd ?? "(server cwd)"}]`);

  const server: CmdApiServer = await startCmdApi(config);
  console.log(`cmdapi: listening on ${server.url}`);

  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e: unknown) => {
  if (e instanceof ConfigError) {
    console.error(`cmdapi: ${e.message}`);
    process.exit(2);
  }
  console.error(e);
  process.exit(1);
});
