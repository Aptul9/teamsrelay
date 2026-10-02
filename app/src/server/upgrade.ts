import type http from "node:http";
import type { WebSocket, WebSocketServer } from "ws";

// What the hubs of this process (browser-hub.ts, call-audio-hub.ts) share: who may open a websocket is the web app's
// to say, asked over HTTP on this same server, and a request it refuses gets a 403 before any upgrade.

// The web app's answer for the request: GET `path` on this same server with `headers`; null when it refuses
export async function askWebApp(server: http.Server, path: string, headers: Record<string, string>): Promise<Record<string, unknown> | null> {
  const address = server.address();
  if (!address || typeof address === "string") return null;
  const host = address.address === "0.0.0.0" || address.address === "::" ? "127.0.0.1" : address.address;
  const r = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${address.port}${path}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
}

// Upgrades to `path` for whoever `check` lets in, then hands the websocket to `join` with what check said
export function acceptUpgrades<T>(
  server: http.Server,
  wss: WebSocketServer,
  path: string,
  check: (req: http.IncomingMessage) => Promise<T | null>,
  join: (who: T, ws: WebSocket) => void,
) {
  server.on("upgrade", (req: http.IncomingMessage, socket, head: Buffer) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== path) return;
    socket.on("error", () => undefined);
    check(req).then(
      (who) => {
        if (who === null) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => join(who, ws));
      },
      () => socket.destroy(),
    );
  });
}
