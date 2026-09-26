import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { controlClient } from "@/lib/control";
import { tempDir } from "./helpers";
import { socketPath } from "./supervisor/fakes";

// Stand-in for the supervisor of the browsers container: answers every request with the next reply
let server: http.Server;
let sock: string;
let requests: string[];
let reply: { status: number; body?: unknown };

beforeAll(async () => {
  sock = socketPath(tempDir());
  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  requests = [];
});

describe("controlClient", () => {
  it("starts, stops and wipes an account", async () => {
    reply = { status: 204 };
    const ctl = controlClient(sock);

    await ctl.start(3);
    await ctl.stop(3);
    await ctl.wipe(3);

    expect(requests).toEqual(["POST /accounts/3/start", "POST /accounts/3/stop", "POST /accounts/3/wipe"]);
  });

  it("tells whether the window of the account came to the front", async () => {
    reply = { status: 200, body: { shown: true } };
    await expect(controlClient(sock).show(2)).resolves.toBe(true);
    reply = { status: 200, body: { shown: false } };
    await expect(controlClient(sock).show(2)).resolves.toBe(false);
    expect(requests).toEqual(["POST /accounts/2/show", "POST /accounts/2/show"]);
  });

  it("passes on the reason of a refusal", async () => {
    reply = { status: 409, body: { detail: "Account 2 is running: stop it first" } };
    await expect(controlClient(sock).wipe(2)).rejects.toMatchObject({ status: 502, message: "Wipe of account 2 failed: Account 2 is running: stop it first" });
    reply = { status: 500 };
    await expect(controlClient(sock).start(2)).rejects.toMatchObject({ status: 502, message: "Start of account 2 failed: status 500" });
  });

  it("says when the browsers container does not answer", async () => {
    const missing = process.platform === "win32" ? `${sock}-missing` : path.join(tempDir(), "missing.sock");
    await expect(controlClient(missing).start(1)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/^Browsers container not reachable/) });
  });
});
