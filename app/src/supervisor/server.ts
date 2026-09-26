import fs from "node:fs";
import http from "node:http";
import { AccountError, type Accounts } from "./accounts";

export type AccountControl = Pick<Accounts, "start" | "stop" | "wipe" | "show" | "status">;

type Options = {
  // the desktop session is up: a browser started before it would find no display
  desktop: Promise<void>;
  log: (line: string) => void;
};

type Reply = { status: number; body?: unknown };

const ACTION = /^\/accounts\/([^/]+)\/(start|stop|wipe|show)$/;

// Control API for the web app, HTTP on a unix socket that only root opens:
//   POST /accounts/N/start | stop | wipe | show        GET /accounts
export function controlServer(accounts: AccountControl, { desktop, log }: Options): http.Server {
  async function handle(method: string, url: string): Promise<Reply> {
    const path = url.split("?")[0];
    if (path === "/accounts") return method === "GET" ? { status: 200, body: accounts.status() } : notAllowed;
    const m = ACTION.exec(path);
    if (!m) return { status: 404, body: { detail: "Not found" } };
    if (method !== "POST") return notAllowed;
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : Number.NaN;
    switch (m[2]) {
      case "start":
        await desktop;
        await accounts.start(n);
        return { status: 204 };
      case "stop":
        await accounts.stop(n);
        return { status: 204 };
      case "wipe":
        await accounts.wipe(n);
        return { status: 204 };
      default:
        return { status: 200, body: { shown: await accounts.show(n) } };
    }
  }

  return http.createServer((req, res) => {
    handle(req.method ?? "", req.url ?? "").then(
      (reply) => send(res, reply),
      (e: unknown) => {
        const status = e instanceof AccountError ? e.status : 500;
        const detail = e instanceof Error ? e.message : String(e);
        if (status >= 500) log(`control: ${req.method} ${req.url} failed: ${detail}`);
        send(res, { status, body: { detail } });
      },
    );
  });
}

const notAllowed: Reply = { status: 405, body: { detail: "Method not allowed" } };

function send(res: http.ServerResponse, { status, body }: Reply) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

// A socket file left by an earlier run would refuse the listen
export async function listen(server: http.Server, socket: string) {
  const posix = process.platform !== "win32";
  if (posix) fs.rmSync(socket, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (posix) fs.chmodSync(socket, 0o600);
}
