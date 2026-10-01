// cmdapi configuration, from the process environment (pm2 passes it, loaded from relay.env by the entry point). Checked
// once at start: the only combination refused is a non-loopback bind with an empty token, so a bad posture fails loudly
// instead of handing an open shell to whoever finds the port.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigError } from "@/agent/config";
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
  // an empty variable (FOO= in relay.env) counts as unset, so a default applies
  const given = Object.fromEntries(Object.keys(Env.shape).map((k) => [k, env[k] === "" ? undefined : env[k]]));
  const r = Env.safeParse(given);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const e = r.data;

  let cwd: string | null = null;
  if (e.CMDAPI_CWD) {
    cwd = path.resolve(e.CMDAPI_CWD);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new ConfigError(`CMDAPI_CWD is not a directory: ${cwd}`);
  }

  const host = e.CMDAPI_HOST;
  const isLoopback = LOOPBACK.has(host);
  // anything that runs arbitrary commands and listens off loopback with no token is a shell for whoever finds the port
  if (!isLoopback && !e.CMDAPI_TOKEN) {
    throw new ConfigError(
      `CMDAPI_HOST is ${host}, which is not loopback, and CMDAPI_TOKEN is empty. ` + "Set a token, or bind 127.0.0.1 and reach it through the tunnel.",
    );
  }

  return {
    host,
    port: e.CMDAPI_PORT,
    token: e.CMDAPI_TOKEN,
    timeout: e.CMDAPI_TIMEOUT,
    maxOutput: e.CMDAPI_MAX_OUTPUT,
    cwd,
    shell: e.CMDAPI_SHELL || defaultShell(),
    isLoopback,
    get url() {
      const h = BIND_ALL.has(host) ? "127.0.0.1" : host;
      return `http://${h}:${this.port}`;
    },
  };
}
