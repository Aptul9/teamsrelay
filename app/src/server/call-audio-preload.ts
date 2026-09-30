import http from "node:http";
import { attachCallAudioHub } from "./call-audio-hub";

// Loaded before the server of Next.js (node --require dist/call-audio.cjs server.js): the server it creates also takes
// the websockets of the sound of the calls of accounts on another computer. Next.js leaves an upgrade on a path of no
// page or route to other listeners of its server.
const create = http.createServer;
http.createServer = function (this: unknown, ...args: unknown[]) {
  const server = (create as (...a: unknown[]) => http.Server).apply(this, args);
  attachCallAudioHub(server);
  return server;
} as typeof http.createServer;
