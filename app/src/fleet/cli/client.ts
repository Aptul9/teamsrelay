// Reaching a host's cmdapi from the control machine. The host's cmdapi binds its own loopback; a reverse SSH tunnel it
// holds open publishes it on the hub VM's loopback at the host's port. So the CLI SSHes the VM (the access gate) and
// curls that loopback port. The request body travels on SSH's stdin into curl (--data-binary @-); the bearer token
// rides the remote curl line.
import { spawn } from "node:child_process";
import type { Result } from "@/fleet/cmdapi/runner";
import type { FleetHost } from "./inventory";

export interface RunRequest {
  command?: string;
  args?: string[];
  cwd?: string;
  timeout?: number;
}

const base = (host: FleetHost) => `http://127.0.0.1:${host.port}`;

// ssh <vm> "curl ... /command" - the VM alias carries its own ssh options (~/.ssh/config); the body is piped in
export function remoteExecArgv(host: FleetHost): string[] {
  const auth = host.token ? `-H 'Authorization: Bearer ${host.token}' ` : "";
  const remote = `curl -sS ${auth}-H 'content-type: application/json' --data-binary @- ${base(host)}/command`;
  return ["ssh", host.vm, remote];
}

export function healthArgv(host: FleetHost): string[] {
  return ["ssh", host.vm, `curl -sS ${base(host)}/health`];
}

function capture(argv: string[], stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

// Run a command on a host and return the cmdapi result. Throws when the hop itself fails (SSH down, tunnel down, cmdapi
// unreachable) - told apart from a command that merely exited non-zero, which comes back as a result.
export async function exec(host: FleetHost, request: RunRequest): Promise<Result> {
  const { code, stdout, stderr } = await capture(remoteExecArgv(host), JSON.stringify(request));
  try {
    return JSON.parse(stdout) as Result;
  } catch {
    const why = stderr.trim() || stdout.trim() || `ssh exited ${code}`;
    throw new Error(`${host.name}: ${why}`);
  }
}

export async function health(host: FleetHost): Promise<boolean> {
  try {
    const { stdout } = await capture(healthArgv(host));
    return JSON.parse(stdout).ok === true;
  } catch {
    return false;
  }
}
