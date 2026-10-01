// The embedded SSH server: a shell into a relay host with no OpenSSH Server and no admin, run inside the host's Node
// process (ssh2, pure JavaScript). Public-key auth only. An `exec` request runs the command through the same runner
// cmdapi uses; a `shell` request spawns an interactive shell piped to the channel (no pseudo-tty: a real one needs a
// native module, so line editing and full-screen programs are limited; `exec` is unaffected). Reached only through the
// host's reverse tunnel to the hub VM.
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Server, utils, type AuthContext, type Connection, type ParsedKey } from "ssh2";
import { errorText, log } from "@/agent/log";
import { defaultShell, run } from "@/fleet/cmdapi/runner";

export interface SshServerOptions {
  port: number;
  host?: string;
  // private host key (OpenSSH or PEM); loadOrCreateHostKey makes one if none exists
  hostKey: string | Buffer;
  // OpenSSH public key lines allowed to log in
  authorizedKeys: string[];
  shell?: string;
  cwd?: string | null;
  maxOutput?: number;
}

export interface SshServer {
  port: number;
  close: () => Promise<void>;
}

function parseAuthorized(lines: string[]): ParsedKey[] {
  return lines.map((line) => {
    const key = utils.parseKey(line);
    if (key instanceof Error) throw new Error(`fleet ssh: bad authorized key: ${key.message}`);
    return Array.isArray(key) ? key[0] : key;
  });
}

// Generate an ed25519 host key on first use and persist it (0600), so the host identity is stable across restarts.
export function loadOrCreateHostKey(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    // make one below
  }
  const pair = (utils.generateKeyPairSync as (t: string) => { private: string; public: string })("ed25519");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pair.private, { mode: 0o600 });
  return pair.private;
}

function authorize(ctx: AuthContext, allowed: ParsedKey[]): void {
  if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
  const presented = ctx.key.data;
  const match = allowed.find((k) => {
    const blob = k.getPublicSSH();
    return k.type === ctx.key.algo && blob.length === presented.length && timingSafeEqual(blob, presented);
  });
  if (!match) return ctx.reject();
  // first phase: the client offers the key without a signature; accept so it signs. second phase: verify the signature.
  if (ctx.signature) {
    if (!ctx.blob) return ctx.reject();
    return match.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject();
  }
  return ctx.accept();
}

function interactiveArgs(shell: string): string[] {
  const name = path.basename(shell).toLowerCase();
  if (name.includes("pwsh") || name.includes("powershell")) return ["-NoLogo", "-NoProfile"];
  if (name === "cmd" || name === "cmd.exe") return [];
  return ["-i"];
}

export function startSshServer(opts: SshServerOptions): Promise<SshServer> {
  const allowed = parseAuthorized(opts.authorizedKeys);
  const shell = opts.shell || defaultShell();
  const cwd = opts.cwd ?? undefined;
  const maxOutput = opts.maxOutput;

  const server = new Server({ hostKeys: [opts.hostKey] }, (client: Connection) => {
    client.on("authentication", (ctx) => authorize(ctx, allowed));
    client.on("error", (e) => log.warn("ssh", errorText(e)));
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        // a client may request a pty before the shell; acknowledge it (there is no real pty behind it)
        session.on("pty", (acc) => acc && acc());
        session.on("exec", (acc, _reject, info) => {
          const stream = acc();
          run({ command: info.command, shell, cwd, maxOutput })
            .then((r) => {
              if (r.stdout) stream.write(r.stdout);
              if (r.stderr) stream.stderr.write(r.stderr);
              stream.exit(r.exitCode ?? 0);
              stream.end();
            })
            .catch((e: unknown) => {
              stream.stderr.write(`${errorText(e)}\n`);
              stream.exit(1);
              stream.end();
            });
        });
        session.on("shell", (acc) => {
          const stream = acc();
          const child = spawn(shell, interactiveArgs(shell), { cwd });
          stream.pipe(child.stdin);
          child.stdout.pipe(stream);
          child.stderr.pipe(stream.stderr);
          child.on("close", (code) => {
            stream.exit(code ?? 0);
            stream.end();
          });
          stream.on("close", () => child.kill());
          child.on("error", (e) => {
            stream.stderr.write(`${errorText(e)}\n`);
            stream.exit(1);
            stream.end();
          });
        });
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      server.removeListener("error", reject);
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
