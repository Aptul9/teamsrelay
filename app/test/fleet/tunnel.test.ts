// The reverse tunnel the agent holds open: ssh -N -R <vmPort>:127.0.0.1:<localPort> <vm>, publishing a local server on
// the hub VM's loopback. The VM port floats in a pool: when a dropped tunnel still holds it, the next port is tried.
// The supervisor reads ssh -v for the verdict, so it is driven here by a stand-in for ssh that prints the same lines.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classify, superviseTunnel, tunnelArgv, type TunnelHandle } from "@/fleet/agent/tunnel";

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

  it("carries its own keepalive and connect timeout, and prints the forward verdict", () => {
    const argv = tunnelArgv("oracle-vm", 8766, 8765);
    expect(argv).toContain("-v");
    expect(argv).toContain("ServerAliveInterval=30");
    expect(argv).toContain("ServerAliveCountMax=3");
    expect(argv).toContain("ConnectTimeout=10");
  });
});

describe("classify", () => {
  it("reads the verdict ssh -v prints for a remote forward", () => {
    expect(classify("debug1: remote forward success for: listen 127.0.0.1:8766, connect 127.0.0.1:8765")).toBe("ok");
    expect(classify("debug1: remote forward failure for: listen 127.0.0.1:8766, connect 127.0.0.1:8765")).toBe("busy");
    expect(classify("Error: remote port forwarding failed for listen port 8766")).toBe("busy");
  });

  it("keeps ssh errors and drops the debug noise", () => {
    expect(classify("debug1: Authentication succeeded (publickey).")).toBeNull();
    expect(classify("OpenSSH_9.6p1, OpenSSL 3.0.13")).toBeNull();
    expect(classify('Authenticated to 84.8.248.192 ([84.8.248.192]:22) using "publickey".')).toBeNull();
    expect(classify("")).toBeNull();
    expect(classify("Timeout, server 84.8.248.192 not responding.")).toBe("note");
    expect(classify("channel 2: open failed: connect failed: Connection refused")).toBe("note");
  });
});

// ssh stand-in: refuses the ports in argv[2] the way a held VM port is refused, grants the others and then stays up
// for argv[3] ms (0 = until killed)
const FAKE_SSH = `
const port = Number(process.argv[1]);
const held = new Set(process.argv[2].split(",").filter(Boolean).map(Number));
const life = Number(process.argv[3]);
if (held.has(port)) {
  console.error("debug1: remote forward failure for: listen 127.0.0.1:" + port + ", connect 127.0.0.1:1");
  console.error("Error: remote port forwarding failed for listen port " + port);
  process.exit(255);
}
console.error("OpenSSH_9.6p1, banner noise");
console.error("debug1: remote forward success for: listen 127.0.0.1:" + port + ", connect 127.0.0.1:1");
setInterval(() => {}, 1000);
if (life) setTimeout(() => process.exit(255), life);
`;

const BASE = 9000;
const handles: TunnelHandle[] = [];

// held is read on every dial, so a test can free or hold a port while the supervisor runs
function supervise(held: Set<number>, life = 0, span = 3) {
  const dials: number[] = [];
  const handle = superviseTunnel("cmdapi", "fake-vm", BASE, 1, {
    span,
    delay: [20, 80],
    argv: (port) => {
      dials.push(port);
      return [process.execPath, "-e", FAKE_SSH, String(port), [...held].join(","), String(life)];
    },
  });
  handles.push(handle);
  return { handle, dials };
}

async function until(done: () => boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const on = (h: TunnelHandle, port: number) => h.state().state === "connected" && h.state().port === port;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const h of handles.splice(0)) h.stop();
  vi.restoreAllMocks();
});

describe("superviseTunnel", () => {
  it("connects on its own port when the VM grants it", async () => {
    const { handle } = supervise(new Set());
    await until(() => on(handle, BASE));
  });

  it("floats to the first free port when the lower ones are held", async () => {
    const { handle, dials } = supervise(new Set([BASE, BASE + 1]));
    await until(() => on(handle, BASE + 2));
    expect(dials.slice(0, 3)).toEqual([BASE, BASE + 1, BASE + 2]);
  });

  it("reports busy while every port of the pool is held, and claims one as soon as it frees", async () => {
    const held = new Set([BASE, BASE + 1, BASE + 2]);
    const { handle } = supervise(held);
    await until(() => handle.state().state === "busy");
    held.delete(BASE + 1);
    await until(() => on(handle, BASE + 1));
  });

  it("scans again from the lowest port after a drop", async () => {
    const held = new Set<number>();
    const { handle } = supervise(held, 150);
    await until(() => on(handle, BASE));
    held.add(BASE); // the dropped session still holds it
    await until(() => on(handle, BASE + 1));
    held.clear(); // the VM let go
    await until(() => on(handle, BASE));
  });

  it("with a span of 1 tries only its own port, however busy", async () => {
    const { handle, dials } = supervise(new Set([BASE]), 0, 1);
    await until(() => handle.state().state === "busy");
    await until(() => dials.length >= 3);
    expect(new Set(dials)).toEqual(new Set([BASE]));
  });

  it("stops dialling once stopped", async () => {
    const { handle, dials } = supervise(new Set([BASE, BASE + 1, BASE + 2]));
    await until(() => handle.state().state === "busy");
    handle.stop();
    await new Promise((r) => setTimeout(r, 100));
    const seen = dials.length;
    await new Promise((r) => setTimeout(r, 250));
    expect(dials.length).toBe(seen);
  });
});
