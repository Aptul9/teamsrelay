// The fleet agent: one host-side process, separate from the relay, that runs the enabled fleet components and the
// reverse tunnels that publish them on the hub VM. node dist/fleet-agent.cjs. Config is fleet.config.json next to
// package.json (or FLEET_CONFIG). Runs under pm2 beside the relay; pm2 keeps it alive and brings it back at logon.
import path from "node:path";
import { ConfigError } from "@/shared/env";
import { errorText, log } from "@/agent/log";
import { cmdApiConfig } from "@/fleet/cmdapi/config";
import { startCmdApi, type CmdApiServer } from "@/fleet/cmdapi/server";
import { loadOrCreateHostKey, startSshServer, type SshServer } from "@/fleet/ssh/server";
import { loadAgentConfigFile, type AgentConfig } from "./config";
import { superviseTunnel, type TunnelHandle } from "./tunnel";

function configPath(): string {
  return process.env.FLEET_CONFIG || path.resolve(process.cwd(), "fleet.config.json");
}

async function start(config: AgentConfig): Promise<void> {
  const closers: Array<() => void | Promise<void>> = [];
  const tunnels: TunnelHandle[] = [];

  if (config.cmdapi.enabled) {
    const { localPort: port, token, timeout, cwd } = config.cmdapi;
    const server: CmdApiServer = await startCmdApi(cmdApiConfig({ host: "127.0.0.1", port, token, timeout, cwd }));
    log.info("fleet", `cmdapi: listening on ${server.url}`);
    closers.push(() => server.close());
    tunnels.push(superviseTunnel("cmdapi", config.vm, config.cmdapi.vmPort as number, config.cmdapi.localPort));
  }

  if (config.ssh.enabled) {
    // library: run the embedded ssh2 server on localPort (default 2022). system: no server, tunnel straight to the
    // host's own sshd (default :22), a real OS login shell that the host's sshd authenticates.
    const localPort = config.ssh.localPort ?? (config.ssh.mode === "system" ? 22 : 2022);
    if (config.ssh.mode === "library") {
      const hostKey = loadOrCreateHostKey(path.resolve(process.cwd(), config.ssh.hostKeyFile));
      const server: SshServer = await startSshServer({ port: localPort, host: "127.0.0.1", hostKey, authorizedKeys: config.ssh.authorizedKeys });
      log.info("fleet", `ssh: embedded server on 127.0.0.1:${server.port} (${config.ssh.authorizedKeys.length} key(s))`);
      closers.push(() => server.close());
    } else {
      log.info("fleet", `ssh: system mode, tunnel to the host's sshd on 127.0.0.1:${localPort}`);
    }
    tunnels.push(superviseTunnel("ssh", config.vm, config.ssh.vmPort as number, localPort));
  }

  if (!config.cmdapi.enabled && !config.ssh.enabled) {
    log.warn("fleet", "no component enabled in fleet.config.json; idling");
  }

  const stop = () => {
    for (const t of tunnels) t.stop();
    void Promise.all(closers.map((c) => c())).then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function main(): Promise<void> {
  const config = loadAgentConfigFile(configPath());
  log.info("fleet", `agent start: vm=${config.vm} cmdapi=${config.cmdapi.enabled} ssh=${config.ssh.enabled}`);
  await start(config);
  // stay up even when nothing is enabled: pm2 would otherwise treat an exit as a crash and flap
  await new Promise<never>(() => undefined);
}

main().catch((e: unknown) => {
  if (e instanceof ConfigError) {
    log.warn("fleet", e.message);
    process.exit(2);
  }
  log.warn("fleet", errorText(e));
  process.exit(1);
});
