// The pm2 app set each relay host runs: the relay always, and the fleet agent as a separate process only when
// FLEET_AGENT is set. fleetApps() is the pure decision behind ecosystem.config.cjs, so it is tested without pm2.
import { describe, expect, it } from "vitest";

const mod = (await import("../../ecosystem.config.cjs")) as unknown as {
  default: { fleetApps: (env: Record<string, string | undefined>, dir: string) => Array<{ name: string; script?: string }> };
};
const fleetApps = mod.default.fleetApps;
const DIR = "/srv/app";

describe("fleetApps", () => {
  it("runs only the relay when FLEET_AGENT is not set", () => {
    expect(fleetApps({}, DIR).map((a) => a.name)).toEqual(["teamsrelay"]);
  });

  it("adds the fleet agent as its own process when FLEET_AGENT is set", () => {
    const apps = fleetApps({ FLEET_AGENT: "on" }, DIR);
    expect(apps.map((a) => a.name)).toEqual(["teamsrelay", "teamsrelay-fleet"]);
    expect(apps.find((a) => a.name === "teamsrelay-fleet")!.script).toBe("dist/fleet-agent.cjs");
  });

  it("keeps the relay as its own separate process", () => {
    const relay = fleetApps({ FLEET_AGENT: "on" }, DIR).find((a) => a.name === "teamsrelay")!;
    expect(relay.script).toBe("dist/relay.cjs");
  });
});
