// How the fleet CLI reaches a host's cmdapi: it SSHes the hub VM and curls the cmdapi published on the VM's loopback by
// the host's reverse tunnel. The command text travels on stdin (curl --data-binary @-); SSH-to-the-VM is the access
// gate, the bearer token defence in depth.
import { describe, expect, it } from "vitest";
import { healthArgv, remoteExecArgv } from "@/fleet/cli/client";
import type { FleetHost } from "@/fleet/cli/inventory";

const host: FleetHost = { name: "zurich", vm: "oracle-vm", port: 8766, token: "z".repeat(32), appDir: "C:/teamsrelay/app" };

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
