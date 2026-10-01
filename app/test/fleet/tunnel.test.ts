// The reverse tunnel the agent holds open: ssh -N -R <vmPort>:127.0.0.1:<localPort> <vm>, publishing a local server on
// the hub VM's loopback. The VM alias carries its own options; ExitOnForwardFailure makes ssh exit (so the supervisor
// redials) when a stale tunnel still holds the VM port.
import { describe, expect, it } from "vitest";
import { tunnelArgv } from "@/fleet/agent/tunnel";

describe("tunnelArgv", () => {
  it("builds the reverse-forward invocation for a component", () => {
    const argv = tunnelArgv("oracle-vm", 8766, 8765);
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("-N");
    expect(argv).toContain("-R");
    expect(argv).toContain("127.0.0.1:8766:127.0.0.1:8765");
    expect(argv).toContain("ExitOnForwardFailure=yes");
    expect(argv).toContain("BatchMode=yes");
    expect(argv[argv.length - 1]).toBe("oracle-vm");
  });
});
