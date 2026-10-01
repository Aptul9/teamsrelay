// cmdapi over HTTP: POST|GET /command runs a command on this machine and returns its result; GET /health is a liveness
// check with no auth. A non-zero exit stays 200 with the exit code in the body; 4xx means the request itself was
// declined (bad token, malformed body, nothing to run). Reached only through the reverse tunnel to the hub VM, so it
// binds loopback by default and never leaves this machine on its own.
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { HttpError } from "@/shared/http-error";
import type { CmdApiConfig } from "./config";
import { run, type RunOptions } from "./runner";

export interface CmdApiServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

function authorize(req: http.IncomingMessage, token: string): void {
  if (!token) return;
  const header = req.headers["authorization"] ?? "";
  const [scheme, presented = ""] = header.split(" ");
  if (scheme.toLowerCase() !== "bearer" || !timingSafeEqual(digest(presented), digest(token))) {
    throw new HttpError(401, "bad or missing bearer token");
  }
}

// Accept JSON, a plain-text body, or ?c= - whichever the caller reached for.
function parse(body: string, contentType: string, query: string | null): RunOptions {
  const kind = contentType.split(";")[0].trim().toLowerCase();
  if (kind === "application/json" && body) {
    let obj: unknown;
    try {
      obj = JSON.parse(body);
    } catch {
      throw new HttpError(422, "invalid JSON body");
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new HttpError(422, "body must be a JSON object");
    const b = obj as Record<string, unknown>;
    if (b.command !== undefined && typeof b.command !== "string") throw new HttpError(422, "command must be a string");
    if (b.args !== undefined && (!Array.isArray(b.args) || b.args.some((a) => typeof a !== "string"))) throw new HttpError(422, "args must be a list of strings");
    if (b.command !== undefined && b.args !== undefined) throw new HttpError(422, "pass command or args, not both");
    if (Array.isArray(b.args) && b.args.length === 0) throw new HttpError(422, "args is empty");
    if (b.command === undefined && b.args === undefined) throw new HttpError(422, "no command or args in the body");
    return {
      command: b.command as string | undefined,
      args: b.args as string[] | undefined,
      cwd: typeof b.cwd === "string" ? b.cwd : undefined,
      env: b.env && typeof b.env === "object" && !Array.isArray(b.env) ? (b.env as Record<string, string>) : undefined,
      timeout: typeof b.timeout === "number" ? b.timeout : undefined,
    };
  }
  if (body) return { command: body };
  if (query) return { command: query };
  throw new HttpError(400, "no command: send JSON, a plain-text body, or ?c=");
}

function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const data = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

export function startCmdApi(config: CmdApiConfig): Promise<CmdApiServer> {
  const server = http.createServer((req, res) => {
    void handle(req, res, config).catch((e: unknown) => {
      if (e instanceof HttpError) return send(res, e.status, { detail: e.message });
      console.error(e);
      send(res, 500, { detail: "internal error" });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : config.port;
      resolve({
        url: `http://${config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host}:${port}`,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, config: CmdApiConfig): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") return send(res, 200, { ok: true });

  if (url.pathname === "/command") {
    authorize(req, config.token);
    const body = await readBody(req);
    const asked = parse(body, req.headers["content-type"] ?? "", url.searchParams.get("c"));
    try {
      const result = await run({
        ...asked,
        cwd: asked.cwd ?? config.cwd ?? undefined,
        timeout: asked.timeout ?? config.timeout,
        maxOutput: config.maxOutput,
        shell: asked.command !== undefined ? config.shell : undefined,
      });
      return send(res, 200, result);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") throw new HttpError(400, `command not found: ${err.path ?? ""}`);
      throw e;
    }
  }

  throw new HttpError(404, "not found");
}
