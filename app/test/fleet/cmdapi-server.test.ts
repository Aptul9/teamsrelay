// The cmdapi HTTP surface: one endpoint that runs a command, one health check. A non-zero exit is not an HTTP error
// (the request succeeded, the command failed); 4xx is kept for a request declined before anything ran. The server binds
// loopback on an ephemeral port for the test; commands use `args` where a shell would differ across platforms.
import { afterEach, describe, expect, it } from "vitest";
import { loadCmdApiConfig } from "@/fleet/cmdapi/config";
import { startCmdApi } from "@/fleet/cmdapi/server";

const node = process.execPath;
let server: { url: string; close: () => Promise<void> } | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(env: Record<string, string | undefined> = {}) {
  server = await startCmdApi(loadCmdApiConfig({ CMDAPI_PORT: "0", ...env }));
  return server.url;
}

describe("cmdapi server", () => {
  it("answers /health without a token", async () => {
    const url = await start();
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("runs a plain-text body command and returns its output", async () => {
    const url = await start();
    const res = await fetch(`${url}/command`, { method: "POST", body: "echo servertest" });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("servertest");
  });

  it("runs a command from the ?c= query", async () => {
    const url = await start();
    const res = await fetch(`${url}/command?c=${encodeURIComponent("echo querytest")}`);
    expect((await res.json()).stdout).toContain("querytest");
  });

  it("runs JSON args with no shell and reports the exit code", async () => {
    const url = await start();
    const body = JSON.stringify({ args: [node, "-e", "process.exit(7)"] });
    const res = await fetch(`${url}/command`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(res.status).toBe(200);
    expect((await res.json()).exitCode).toBe(7);
  });

  it("rejects an empty request with 400", async () => {
    const url = await start();
    const res = await fetch(`${url}/command`, { method: "POST", body: "" });
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toBeTruthy();
  });

  it("rejects a body that passes both command and args with 422", async () => {
    const url = await start();
    const body = JSON.stringify({ command: "echo hi", args: [node, "-e", ""] });
    const res = await fetch(`${url}/command`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(res.status).toBe(422);
  });

  it("enforces the bearer token on /command when one is set", async () => {
    const url = await start({ CMDAPI_TOKEN: "s".repeat(32) });
    const noToken = await fetch(`${url}/command`, { method: "POST", body: "echo x" });
    expect(noToken.status).toBe(401);
    const bad = await fetch(`${url}/command`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "echo x" });
    expect(bad.status).toBe(401);
    const good = await fetch(`${url}/command`, { method: "POST", headers: { authorization: `Bearer ${"s".repeat(32)}` }, body: "echo ok" });
    expect(good.status).toBe(200);
    expect((await good.json()).stdout).toContain("ok");
  });
});
