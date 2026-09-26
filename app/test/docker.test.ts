import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dockerClient } from "@/lib/docker";

// Stand-in for the socket proxy: answers every request with the next reply
let server: http.Server;
let api: string;
let requests: string[];
let reply: { status: number; body?: unknown };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  requests = [];
});

describe("dockerClient", () => {
  it("starts, stops with 10 s of grace, and treats 304 as done", async () => {
    reply = { status: 204 };
    await dockerClient(api).start("teams-chromium-3");
    await dockerClient(api).stop("teams-agent-3");
    reply = { status: 304 };
    await dockerClient(api).start("teams-chromium-3");
    expect(requests).toEqual([
      "POST /containers/teams-chromium-3/start",
      "POST /containers/teams-agent-3/stop?t=10",
      "POST /containers/teams-chromium-3/start",
    ]);
  });

  it("returns the exit code of the container, which Docker sends with status 200", async () => {
    reply = { status: 200, body: { StatusCode: 1 } };
    await expect(dockerClient(api).wait("teams-wipe-3")).resolves.toBe(1);
    reply = { status: 200, body: { StatusCode: 0 } };
    await expect(dockerClient(api).wait("teams-wipe-3")).resolves.toBe(0);
    expect(requests).toEqual(["POST /containers/teams-wipe-3/wait", "POST /containers/teams-wipe-3/wait"]);
  });

  it("fails when Docker reports no exit code", async () => {
    reply = { status: 200, body: { StatusCode: -1, Error: { Message: "context canceled" } } };
    await expect(dockerClient(api).wait("teams-wipe-3")).rejects.toThrow(/wait teams-wipe-3 failed: context canceled/);
    reply = { status: 200, body: {} };
    await expect(dockerClient(api).wait("teams-wipe-3")).rejects.toThrow(/wait teams-wipe-3 failed: no exit code/);
  });

  it("asks for a deploy when the container does not exist, and passes on a refusal of the proxy", async () => {
    reply = { status: 404, body: { message: "No such container: teams-wipe-3" } };
    await expect(dockerClient(api).wait("teams-wipe-3")).rejects.toThrow(/teams-wipe-3 does not exist: deploy again/);
    reply = { status: 403 };
    await expect(dockerClient(api).start("teams-wipe-3")).rejects.toThrow(/start teams-wipe-3 failed \(403\)/);
  });
});
