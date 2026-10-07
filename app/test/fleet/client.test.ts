// How the fleet CLI reaches a host's cmdapi: it SSHes the hub VM and curls the cmdapi published on the VM's loopback by
// the host's reverse tunnel. The command text travels on stdin (curl --data-binary @-); SSH-to-the-VM is the access
// gate, the bearer token defence in depth. A host's cmdapi floats in a pool of VM ports, so the CLI first asks the VM
// which port answers to the host's token.
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { healthArgv, probeScript, remoteExecArgv, resolve } from "@/fleet/cli/client";
import type { FleetHost } from "@/fleet/cli/inventory";

const host: FleetHost = { name: "zurich", vm: "oracle-vm", port: 8766, span: 1, token: "z".repeat(32), appDir: "C:/teamsrelay/app" };

describe("remoteExecArgv", () => {
  it("SSHes the VM and curls the cmdapi on the VM loopback, reading the body from stdin", () => {
    const argv = remoteExecArgv(host);
    expect(argv[0]).toBe("ssh");
    expect(argv[1]).toBe("oracle-vm");
    const remote = argv[2];
    expect(remote).toContain("http://127.0.0.1:8766/command");
    expect(remote).toContain("--data-binary @-");
    expect(remote).toContain("content-type: application/json");
    expect(remote).toContain(`Authorization: Bearer ${"z".repeat(32)}`);
  });

  it("omits the Authorization header when the host has no token", () => {
    const remote = remoteExecArgv({ ...host, token: "" })[2];
    expect(remote).not.toContain("Authorization");
  });
});

describe("healthArgv", () => {
  it("curls /health on the VM loopback, no body", () => {
    const remote = healthArgv(host)[2];
    expect(remote).toContain("http://127.0.0.1:8766/health");
    expect(remote).not.toContain("--data-binary");
  });
});

describe("resolve", () => {
  it("leaves a fixed host, or one without a token, on its configured port without asking the VM", async () => {
    expect(await resolve(host)).toBe(host);
    const floating = { ...host, span: 6 };
    expect(await resolve({ ...floating, token: "" })).toEqual({ ...floating, token: "" });
  });
});

describe("probeScript", () => {
  it("tries every port of the host's pool with its token", () => {
    const script = probeScript({ ...host, span: 3 });
    expect(script).toContain("for p in 8766 8767 8768;");
    expect(script).toContain(`Authorization: Bearer ${"z".repeat(32)}`);
    expect(script).toContain("http://127.0.0.1:$p/command?c=echo");
  });
});

// The probe runs on the VM, so it is run here for real: sh and curl against stand-ins for the cmdapi of each host
const hasShCurl = spawnSync("sh", ["-c", "command -v curl"]).status === 0;
const servers: http.Server[] = [];

async function freePool(span: number): Promise<number> {
  for (let tries = 0; tries < 50; tries++) {
    const base = 30000 + Math.floor(Math.random() * 20000);
    const held: net.Server[] = [];
    try {
      for (let i = 0; i < span; i++) {
        const s = net.createServer();
        await new Promise<void>((ok, bad) => s.once("error", bad).listen(base + i, "127.0.0.1", ok));
        held.push(s);
      }
      return base;
    } catch {
      continue;
    } finally {
      await Promise.all(held.map((s) => new Promise((r) => s.close(r))));
    }
  }
  throw new Error("no free port range");
}

// a cmdapi that opens for one token only: 200 for it on /command, 401 for any other
function cmdapi(port: number, token: string): Promise<void> {
  return new Promise((ok) => {
    const s = http.createServer((req, res) => {
      res.statusCode = req.url?.startsWith("/command") && req.headers.authorization === `Bearer ${token}` ? 200 : 401;
      res.end("{}");
    });
    servers.push(s);
    s.listen(port, "127.0.0.1", ok);
  });
}

function runScript(script: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const c = spawn("sh", ["-c", script]);
    let stdout = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.on("close", (code) => resolve({ code, stdout }));
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe.skipIf(!hasShCurl)("probeScript on a VM stand-in", () => {
  it("names the port whose cmdapi accepts the host's token, past a neighbour that refuses it", async () => {
    const base = await freePool(3);
    await cmdapi(base, "o".repeat(32)); // another host's cmdapi on the lowest port
    await cmdapi(base + 1, "z".repeat(32)); // this host, floated one up
    const r = await runScript(probeScript({ ...host, port: base, span: 3 }));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(String(base + 1));
  });

  it("fails when nothing answers to the token", async () => {
    const base = await freePool(3);
    await cmdapi(base + 2, "o".repeat(32));
    const r = await runScript(probeScript({ ...host, port: base, span: 3 }));
    expect(r.code).toBe(1);
    expect(r.stdout.trim()).toBe("");
  });
});
