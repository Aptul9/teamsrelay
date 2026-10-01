// The reverse SSH tunnel the agent holds open for a component: it publishes a local loopback server on the hub VM's
// loopback at a chosen port. The agent supervises it (redial with backoff) the way pm2 supervises the agent itself, so
// one agent process owns every tunnel instead of a pm2 app per tunnel.
import { spawn, type ChildProcess } from "node:child_process";
import { log } from "@/agent/log";

export function tunnelArgv(vm: string, vmPort: number, localPort: number): string[] {
  // The VM alias (~/.ssh/config) carries its own keepalive; ExitOnForwardFailure makes ssh exit (so we redial) when
  // the VM port is still held by a dropped tunnel.
  return ["ssh", "-N", "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes", "-R", `127.0.0.1:${vmPort}:127.0.0.1:${localPort}`, vm];
}

export interface TunnelHandle {
  stop: () => void;
}

export function superviseTunnel(name: string, vm: string, vmPort: number, localPort: number): TunnelHandle {
  let stopped = false;
  let child: ChildProcess | null = null;
  let delay = 1000;

  const dial = () => {
    if (stopped) return;
    const argv = tunnelArgv(vm, vmPort, localPort);
    child = spawn(argv[0], argv.slice(1), { stdio: "ignore" });
    child.on("error", (e) => log.warn("fleet", `tunnel ${name}: ${e.message}`));
    child.on("exit", (code) => {
      child = null;
      if (stopped) return;
      log.warn("fleet", `tunnel ${name} dropped (code ${code}); redialing in ${delay} ms`);
      const wait = delay;
      delay = Math.min(delay * 2, 30000);
      setTimeout(dial, wait);
    });
    // once it has held for a while, reset the backoff so the next genuine drop retries fast
    setTimeout(() => {
      if (child && !stopped) delay = 1000;
    }, 20000);
  };

  dial();
  return {
    stop: () => {
      stopped = true;
      if (child) child.kill();
    },
  };
}
