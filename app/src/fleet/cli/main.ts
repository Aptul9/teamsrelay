// fleet: drive the relay hosts from one place. node dist/fleet.cjs <command> <host|all> ...
//   fleet exec   <host|all> <command...>   run a command on the host(s) through its cmdapi, print stdout/stderr/exit
//   fleet update <host|all>                pull, npm ci, build the relay, restart it under pm2
//   fleet status <host|all>                cmdapi reachable? relay online under pm2? how many restarts?
// Hosts come from the inventory JSON (FLEET_INVENTORY, else fleet.hosts.json next to package.json). Fan-out is
// sequential: a bad update is seen before it reaches the next host. A host's cmdapi floats in a pool of VM ports, so
// each host is resolved to the port that answers to its token before anything is sent.
import path from "node:path";
import { exec, health, resolve, type RunRequest } from "./client";
import { loadInventory, targets, type FleetHost } from "./inventory";
import { updateRequest } from "./update";

const USAGE = "usage: fleet <exec|update|status> <host|all> [command...]";

function inventoryPath(): string {
  return process.env.FLEET_INVENTORY || path.resolve(process.cwd(), "fleet.hosts.json");
}

// the VM ports a host may be on, for the lines that say none of them answered
const pool = (host: FleetHost) => (host.span > 1 ? `${host.port}-${host.port + host.span - 1}` : `${host.port}`);

// at: the host resolved to its live port, or null when none answered
function header(host: FleetHost, at: FleetHost | null): void {
  console.log(`\n=== ${host.name} (${host.vm}:${at ? at.port : pool(host)})`);
}

// Print a cmdapi result the way a shell would show it, and return true when the command succeeded
function report(r: Awaited<ReturnType<typeof exec>>): boolean {
  if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : r.stdout + "\n");
  if (r.stderr) process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : r.stderr + "\n");
  if (r.timedOut) console.error("(timed out)");
  if (r.truncated) console.error("(output truncated)");
  console.log(`exit ${r.exitCode}`);
  return r.exitCode === 0 && !r.timedOut;
}

// One request per host, one host after the other
async function runExec(hosts: FleetHost[], request: (host: FleetHost) => RunRequest): Promise<boolean> {
  let ok = true;
  for (const host of hosts) {
    const at = await resolve(host);
    header(host, at);
    if (!at) {
      console.error(`${host.name}: no cmdapi on ${host.vm}:${pool(host)} answers to its token`);
      ok = false;
      continue;
    }
    try {
      ok = report(await exec(at, request(at))) && ok;
    } catch (e) {
      console.error((e as Error).message);
      ok = false;
    }
  }
  return ok;
}

async function runStatus(hosts: FleetHost[]): Promise<boolean> {
  let ok = true;
  for (const host of hosts) {
    const at = await resolve(host);
    header(host, at);
    if (!at || !(await health(at))) {
      console.log("cmdapi: unreachable");
      ok = false;
      continue;
    }
    console.log("cmdapi: ok");
    try {
      const r = await exec(at, { command: "npx pm2 jlist", cwd: host.appDir, timeout: 30 });
      const relay = (JSON.parse(r.stdout) as Array<{ name: string; pm2_env?: { status?: string; restart_time?: number } }>).find((p) => p.name === "teamsrelay");
      if (!relay) console.log("relay: not under pm2");
      else {
        console.log(`relay: ${relay.pm2_env?.status ?? "unknown"} (restarts ${relay.pm2_env?.restart_time ?? "?"})`);
        if (relay.pm2_env?.status !== "online") ok = false;
      }
    } catch (e) {
      console.error(`relay: ${(e as Error).message}`);
      ok = false;
    }
  }
  return ok;
}

async function main(): Promise<number> {
  const [command, selector, ...rest] = process.argv.slice(2);
  if (!command || !selector) {
    console.error(USAGE);
    return 2;
  }
  const hosts = targets(loadInventory(inventoryPath()), selector);

  switch (command) {
    case "exec": {
      if (rest.length === 0) {
        console.error("exec needs a command");
        return 2;
      }
      return (await runExec(hosts, () => ({ command: rest.join(" ") }))) ? 0 : 1;
    }
    case "update":
      return (await runExec(hosts, updateRequest)) ? 0 : 1;
    case "status":
      return (await runStatus(hosts)) ? 0 : 1;
    default:
      console.error(`unknown command ${command}\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
