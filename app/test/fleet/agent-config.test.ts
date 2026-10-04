// The fleet agent's config file (fleet.config.json): one hub VM, and per-component enable with its own VM loopback port.
// cmdapi and ssh are independent; each off by default; an enabled component must carry what it needs.
import { describe, expect, it } from "vitest";
import { cmdapiLocalPort, parseAgentConfig, sshLocalPort } from "@/fleet/agent/config";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEY test@host";

describe("agent config", () => {
  it("fills defaults for an enabled cmdapi", () => {
    const c = parseAgentConfig({ vm: "oracle-vm", cmdapi: { enabled: true, vmPort: 8766, token: "t".repeat(32) } });
    expect(c.vm).toBe("oracle-vm");
    expect(c.cmdapi.enabled).toBe(true);
    expect(c.cmdapi.vmPort).toBe(8766);
    expect(c.cmdapi.localPort).toBe(8765);
    expect(c.cmdapi.timeout).toBe(600);
    expect(c.ssh.enabled).toBe(false);
  });

  it("defaults an enabled ssh to the library (embedded ssh2) mode", () => {
    const c = parseAgentConfig({ vm: "oracle-vm", ssh: { enabled: true, vmPort: 8822, authorizedKeys: [KEY] } });
    expect(c.ssh.enabled).toBe(true);
    expect(c.ssh.mode).toBe("library");
    expect(c.ssh.vmPort).toBe(8822);
    expect(c.ssh.hostKeyFile).toBe("state/fleet/ssh_host_key");
    expect(c.ssh.authorizedKeys).toEqual([KEY]);
  });

  it("accepts system mode (tunnel to the host's own sshd) without authorized keys", () => {
    const c = parseAgentConfig({ vm: "oracle-vm", ssh: { enabled: true, mode: "system", vmPort: 8822 } });
    expect(c.ssh.mode).toBe("system");
    expect(c.ssh.enabled).toBe(true);
  });

  it("allows every component disabled (agent idles)", () => {
    const c = parseAgentConfig({ vm: "oracle-vm" });
    expect(c.cmdapi.enabled).toBe(false);
    expect(c.ssh.enabled).toBe(false);
  });

  it("requires a hub VM", () => {
    expect(() => parseAgentConfig({ cmdapi: { enabled: true, vmPort: 8766, token: "t".repeat(32) } })).toThrow();
  });

  it("requires a port and a token for an enabled cmdapi", () => {
    expect(() => parseAgentConfig({ vm: "oracle-vm", cmdapi: { enabled: true, token: "t".repeat(32) } })).toThrow();
    expect(() => parseAgentConfig({ vm: "oracle-vm", cmdapi: { enabled: true, vmPort: 8766 } })).toThrow();
  });

  it("requires a port and at least one authorized key for an enabled ssh", () => {
    expect(() => parseAgentConfig({ vm: "oracle-vm", ssh: { enabled: true, authorizedKeys: [KEY] } })).toThrow();
    expect(() => parseAgentConfig({ vm: "oracle-vm", ssh: { enabled: true, vmPort: 8822, authorizedKeys: [] } })).toThrow();
  });
});

describe("instance offset", () => {
  it("defaults to 0: local ports are the bases", () => {
    const c = parseAgentConfig({ vm: "oracle-vm", cmdapi: { enabled: true, vmPort: 8766, token: "t".repeat(32) }, ssh: { enabled: true, vmPort: 8822, authorizedKeys: [KEY] } });
    expect(c.instance).toBe(0);
    expect(cmdapiLocalPort(c)).toBe(8765);
    expect(sshLocalPort(c)).toBe(2022);
  });

  it("shifts the local port of every bound component by N, leaving the VM port alone", () => {
    const c = parseAgentConfig({ instance: 3, vm: "oracle-vm", cmdapi: { enabled: true, vmPort: 8766, token: "t".repeat(32) }, ssh: { enabled: true, vmPort: 8822, authorizedKeys: [KEY] } });
    expect(cmdapiLocalPort(c)).toBe(8768);
    expect(sshLocalPort(c)).toBe(2025);
    // the VM port is the explicit per-host one and does not move
    expect(c.cmdapi.vmPort).toBe(8766);
    expect(c.ssh.vmPort).toBe(8822);
  });

  it("does not shift system-mode ssh: that port is the host's own sshd", () => {
    const c = parseAgentConfig({ instance: 4, vm: "oracle-vm", ssh: { enabled: true, mode: "system", vmPort: 8822 } });
    expect(sshLocalPort(c)).toBe(22);
  });

  it("shifts a custom ssh localPort too, in library mode", () => {
    const c = parseAgentConfig({ instance: 2, vm: "oracle-vm", ssh: { enabled: true, localPort: 3000, vmPort: 8822, authorizedKeys: [KEY] } });
    expect(sshLocalPort(c)).toBe(3002);
  });

  it("refuses an instance that pushes a bound port past 65535", () => {
    expect(() => parseAgentConfig({ instance: 100, vm: "oracle-vm", cmdapi: { enabled: true, localPort: 65500, vmPort: 8766, token: "t".repeat(32) } })).toThrow(/65535/);
  });
});
