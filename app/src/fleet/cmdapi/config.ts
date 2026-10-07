// cmdapi configuration, from the process environment (pm2 passes it, loaded from relay.env by the entry point). Checked
// once at start: the only combination refused is a non-loopback bind with an empty token, so a bad posture fails loudly
// instead of being left open on the network.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigError, parseEnv } from "@/shared/env";
import { defaultShell } from "./runner";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const BIND_ALL = new Set(["0.0.0.0", "::"]);

const Env = z.object({
  CMDAPI_HOST: z.string().default("127.0.0.1"),
  // 0 binds an ephemeral port (used by the tests); a real host sets a fixed one
  CMDAPI_PORT: z.coerce.number().int().min(0).max(65535).default(8765),
  CMDAPI_TOKEN: z.string().default(""),
  // seconds before a command is killed with its whole tree; generous, because an update runs npm ci
  CMDAPI_TIMEOUT: z.coerce.number().positive().default(600),
  // bytes kept per stream (stdout, stderr)
  CMDAPI_MAX_OUTPUT: z.coerce.number().int().positive().default(1_000_000),
  // default working directory for commands; empty = the server's own cwd
  CMDAPI_CWD: z.string().default(""),
  // shell for string commands; empty = the platform default (PowerShell on Windows, /bin/sh on POSIX)
  CMDAPI_SHELL: z.string().default(""),
});

export interface CmdApiConfig {
  host: string;
  port: number;
  token: string;
  timeout: number;
  maxOutput: number;
  cwd: string | null;
  shell: string;
  readonly isLoopback: boolean;
  readonly url: string;
}

export function loadCmdApiConfig(env: Record<string, string | undefined> = process.env): CmdApiConfig {
  const e = parseEnv(Env, env);
  return cmdApiConfig({
    host: e.CMDAPI_HOST,
    port: e.CMDAPI_PORT,
    token: e.CMDAPI_TOKEN,
    timeout: e.CMDAPI_TIMEOUT,
    maxOutput: e.CMDAPI_MAX_OUTPUT,
    cwd: e.CMDAPI_CWD,
    shell: e.CMDAPI_SHELL,
  });
}

// The configuration from its parts, as the environment above or fleet.config.json give them ("" for cwd and shell:
// the defaults), checked the same way whichever gave them
export function cmdApiConfig(o: { host: string; port: number; token: string; timeout: number; maxOutput?: number; cwd: string; shell?: string }): CmdApiConfig {
  let cwd: string | null = null;
  if (o.cwd) {
    cwd = path.resolve(o.cwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new ConfigError(`CMDAPI_CWD is not a directory: ${cwd}`);
  }

  const host = o.host;
  const isLoopback = LOOPBACK.has(host);
  // off loopback with no token would be open on the network
  if (!isLoopback && !o.token) {
    throw new ConfigError(
      `CMDAPI_HOST is ${host}, which is not loopback, and CMDAPI_TOKEN is empty. ` + "Set a token, or bind 127.0.0.1 and reach it through the tunnel.",
    );
  }

  return {
    host,
    port: o.port,
    token: o.token,
    timeout: o.timeout,
    maxOutput: o.maxOutput ?? 1_000_000,
    cwd,
    shell: o.shell || defaultShell(),
    isLoopback,
    get url() {
      const h = BIND_ALL.has(host) ? "127.0.0.1" : host;
      return `http://${h}:${this.port}`;
    },
  };
}
