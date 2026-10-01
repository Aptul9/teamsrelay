// The pm2 app set each relay host runs is flaggable per component: the relay always, cmdapi and its reverse tunnel only
// when enabled. fleetApps() is the pure decision behind ecosystem.config.cjs, so it is tested without pm2.
import { describe, expect, it } from "vitest";

const mod = (await import("../../ecosystem.config.cjs")) as unknown as {
  default: { fleetApps: (env: Record<string, string | undefined>, dir: string) => Array<{ name: string; script?: string; args?: string[] }> };
};
const fleetApps = mod.default.fleetApps;
const DIR = "/srv/app";

describe("fleetApps", () => {
  it("runs only the relay when no fleet flags are set", () => {
    expect(fleetApps({}, DIR).map((a) => a.name)).toEqual(["teamsrelay"]);
  });

  it("adds cmdapi and its reverse tunnel when the hub VM and the cmdapi port are both set", () => {
    const apps = fleetApps({ FLEET_VM: "oracle-vm", FLEET_CMDAPI_PORT: "8766", CMDAPI_PORT: "8765" }, DIR);
    const names = apps.map((a) => a.name);
    expect(names).toContain("teamsrelay-cmdapi");
    expect(names).toContain("teamsrelay-cmdapi-tunnel");
    const tunnel = apps.find((a) => a.name === "teamsrelay-cmdapi-tunnel")!;
    expect(tunnel.script).toBe("ssh");
    expect(tunnel.args).toContain("-R");
    expect(tunnel.args).toContain("127.0.0.1:8766:127.0.0.1:8765");
    expect(tunnel.args).toContain("oracle-vm");
  });

  it("keeps cmdapi off when only one of the hub VM or its port is set", () => {
    expect(fleetApps({ FLEET_VM: "oracle-vm" }, DIR).map((a) => a.name)).toEqual(["teamsrelay"]);
    expect(fleetApps({ FLEET_CMDAPI_PORT: "8766" }, DIR).map((a) => a.name)).toEqual(["teamsrelay"]);
  });

  it("targets cmdapi's default port 8765 on the host side when CMDAPI_PORT is unset", () => {
    const tunnel = fleetApps({ FLEET_VM: "oracle-vm", FLEET_CMDAPI_PORT: "8766" }, DIR).find((a) => a.name === "teamsrelay-cmdapi-tunnel")!;
    expect(tunnel.args).toContain("127.0.0.1:8766:127.0.0.1:8765");
  });
});
