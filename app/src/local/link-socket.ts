import { type Agent, WebSocket } from "undici";

// The websockets this relay opens to the server it joined, with its token: the browser for MCP clients
// (browser-link.ts) and the sound of a call (call-bridge.ts).

// What a link needs of a websocket: undici's, or a fake in the tests
export type LinkSocket = {
  binaryType?: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type OpenSocket = (url: string, token: string) => LinkSocket;

// The socket to `path` of the server at `server`. `on` hears it only while `current()` is still that socket: one
// replaced or dropped since says nothing.
export function openLink(
  o: { server: string; path: string; token: string; dispatcher: Agent; open?: OpenSocket; current: () => LinkSocket | null },
  on: { open(s: LinkSocket): void; message(s: LinkSocket, data: unknown): void; close(): void },
): LinkSocket {
  const url = o.server.replace(/^http/, "ws") + o.path;
  const s = o.open ? o.open(url, o.token) : (new WebSocket(url, { headers: { Authorization: `Bearer ${o.token}` }, dispatcher: o.dispatcher }) as unknown as LinkSocket);
  s.onopen = () => {
    if (o.current() === s) on.open(s);
  };
  s.onmessage = (ev) => {
    if (o.current() === s) on.message(s, ev.data);
  };
  s.onerror = () => undefined;
  s.onclose = () => {
    if (o.current() === s) on.close();
  };
  return s;
}
