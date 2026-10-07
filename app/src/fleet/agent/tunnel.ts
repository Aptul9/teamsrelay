// The reverse SSH tunnel the agent holds open for a component: it publishes a local loopback server on the hub VM's
// loopback. The agent supervises it (redial with backoff) the way pm2 supervises the agent itself, so one agent process
// owns every tunnel instead of a pm2 app per tunnel.
//
// The VM port floats inside a pool. A host that went to sleep leaves its session on the VM, holding the port until the
// VM's sshd gives up on it (ClientAliveInterval), so every dial walks vmPort..vmPort+span-1 from the lowest and keeps
// the first port the VM grants. ssh -v is the only place that verdict is printed, so the supervisor reads it and logs
// one line per event.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { log } from "@/agent/log";

export function tunnelArgv(vm: string, vmPort: number, localPort: number): string[] {
  // Keepalive is set here, not left to the VM alias: a host whose alias lacks it would keep a dead tunnel for good after
  // a sleep. ExitOnForwardFailure makes ssh exit (so the next port is tried) when the VM port is already held.
  return [
    "ssh", "-v", "-N",
    "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=10",
    "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes",
    "-R", `127.0.0.1:${vmPort}:127.0.0.1:${localPort}`, vm,
  ];
}

const QUIET = ["debug", "OpenSSH_", "Authenticated to", "Transferred:", "Bytes per second"];

// What a line of ssh -v means: "ok" (the VM granted the port), "busy" (it did not), "note" (an ssh error worth logging)
export function classify(line: string): "ok" | "busy" | "note" | null {
  if (line.includes("remote forward success")) return "ok";
  if (line.includes("remote forward failure") || line.includes("remote port forwarding failed")) return "busy";
  const text = line.trim();
  return text && !QUIET.some((p) => text.startsWith(p)) ? "note" : null;
}

export interface TunnelState {
  state: "dialling" | "connected" | "busy";
  port: number | null;
}

export interface TunnelHandle {
  stop: () => void;
  state: () => TunnelState;
}

export interface TunnelOptions {
  // VM ports vmPort..vmPort+span-1 are tried in order; 1 is the one fixed port
  span?: number;
  // the ssh command for one VM port; tests swap in a stand-in
  argv?: (port: number) => string[];
  // redial backoff: first wait and ceiling, in ms
  delay?: [number, number];
}

interface Outcome {
  verdict: "up" | "busy" | "fail";
  code: number | null;
  heldMs: number;
}

// a tunnel that held this long before dropping counts as a genuine drop: the next redial is fast again
const HELD_MS = 20000;

export function superviseTunnel(name: string, vm: string, vmPort: number, localPort: number, opts: TunnelOptions = {}): TunnelHandle {
  const span = opts.span ?? 1;
  const argvFor = opts.argv ?? ((port: number) => tunnelArgv(vm, port, localPort));
  const [minDelay, maxDelay] = opts.delay ?? [1000, 30000];
  const pool = span === 1 ? `${vmPort}` : `${vmPort}-${vmPort + span - 1}`;
  let stopped = false;
  let child: ChildProcess | null = null;
  let wake: (() => void) | null = null;
  let delay = minDelay;
  let current: TunnelState = { state: "dialling", port: null };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  // One ssh at one VM port: "up" once the VM granted it (settled when the link drops), "busy" when the VM refused it,
  // "fail" for anything else (network down, auth, connect timeout)
  const dial = (port: number) =>
    new Promise<Outcome>((resolve) => {
      const argv = argvFor(port);
      const c = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
      child = c;
      let verdict: Outcome["verdict"] = "fail";
      let upAt = 0;
      let settled = false;
      const settle = (code: number | null) => {
        if (settled) return;
        settled = true;
        child = null;
        resolve({ verdict, code, heldMs: upAt ? Date.now() - upAt : 0 });
      };
      c.on("error", (e) => {
        log.warn("fleet", `tunnel ${name}: ${e.message}`);
        if (c.pid === undefined) settle(null);
      });
      createInterface({ input: c.stderr! }).on("line", (line) => {
        const kind = classify(line);
        if (kind === "ok") {
          verdict = "up";
          upAt = Date.now();
          current = { state: "connected", port };
          log.info("fleet", `tunnel ${name} connected`, { vm, port });
        } else if (kind === "busy") {
          if (verdict !== "up") verdict = "busy";
        } else if (kind === "note") {
          log.warn("fleet", `tunnel ${name}: ${line.trim()}`);
        }
      });
      c.on("close", settle);
    });

  void (async () => {
    while (!stopped) {
      let outcome: Outcome = { verdict: "fail", code: null, heldMs: 0 };
      for (let port = vmPort; port < vmPort + span && !stopped; port++) {
        current = { state: "dialling", port: null };
        log.info("fleet", `tunnel ${name} dialling`, { vm, port });
        outcome = await dial(port);
        if (outcome.verdict !== "busy") break;
        log.warn("fleet", `tunnel ${name} port busy`, { vm, port });
      }
      if (stopped) return;
      if (outcome.heldMs >= HELD_MS) delay = minDelay;
      const wait = delay;
      delay = Math.min(delay * 2, maxDelay);
      current = { state: outcome.verdict === "busy" ? "busy" : "dialling", port: null };
      const why = outcome.verdict === "up" ? `dropped (code ${outcome.code})` : outcome.verdict === "busy" ? `no free port in ${pool}` : `failed (code ${outcome.code})`;
      log.warn("fleet", `tunnel ${name} ${why}; redialing in ${wait} ms`);
      await sleep(wait);
    }
  })();

  return {
    stop: () => {
      stopped = true;
      wake?.();
      child?.kill();
    },
    state: () => current,
  };
}
