// TeamsRelay supervisor: the browser and the agent of every Teams account, in the browsers container, started,
// stopped and wiped on request of the web app. Runs as root, an s6 service of the image (app/docker/browsers).
// Built into dist/supervisor.cjs (esbuild).
//   node supervisor.cjs           runs the supervisor (environment: src/supervisor/config.ts)
//   node supervisor.cjs --check   loads the configuration, then exits
//   node supervisor.cjs status    prints the state of the accounts, asked to the running supervisor
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { errorText, format } from "../agent/log";
import { Accounts } from "./accounts";
import { ConfigError, loadConfig } from "./config";
import { controlServer, listen } from "./server";

const say = (message: string) => console.log(format("supervisor", message));

async function waitForFile(file: string) {
  const start = Date.now();
  let told = false;
  while (!fs.existsSync(file)) {
    if (!told && Date.now() - start > 30_000) {
      say(`waiting for the desktop session (${file})`);
      told = true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function status(socket: string): Promise<number> {
  return new Promise((resolve) => {
    http
      .get({ socketPath: socket, path: "/accounts" }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          console.log(body);
          resolve(res.statusCode === 200 ? 0 : 1);
        });
      })
      .on("error", (e) => {
        console.error(`supervisor not reachable on ${socket}: ${e.message}`);
        resolve(1);
      });
  });
}

async function main() {
  const cfg = loadConfig();
  if (process.argv.includes("--check")) return say(`check ok accounts=${cfg.accounts.slotCount}`);
  if (process.argv[2] === "status") process.exit(await status(cfg.socket));
  const accounts = new Accounts(cfg.accounts, { log: (line) => console.log(line) });
  const { XDG_RUNTIME_DIR, WAYLAND_DISPLAY } = cfg.accounts.session;
  const server = controlServer(accounts, { desktop: waitForFile(path.join(XDG_RUNTIME_DIR, WAYLAND_DISPLAY)), log: say });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      server.close();
      void accounts.stopAll().then(() => process.exit(0));
    });
  }
  fs.mkdirSync(path.dirname(cfg.socket), { recursive: true });
  await listen(server, cfg.socket);
  say(`listening socket=${cfg.socket} accounts=1-${cfg.accounts.slotCount}`);
}

main().catch((e: unknown) => {
  say(e instanceof ConfigError ? `configuration: ${e.message}` : errorText(e));
  process.exit(1);
});
