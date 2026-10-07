// The update a relay host runs: pull the checkout, install deps without the better-sqlite3 build (it ships prebuilt
// binaries; without --ignore-scripts npm tries to compile it), rebuild the relay bundle, restart it under pm2.
import { describe, expect, it } from "vitest";
import type { FleetHost } from "@/fleet/cli/inventory";
import { UPDATE_STEPS, updateCommand, updateRequest } from "@/fleet/cli/update";

const host: FleetHost = { name: "zurich", vm: "oracle-vm", port: 8766, span: 1, token: "z".repeat(32), appDir: "C:/teamsrelay/app" };

describe("update", () => {
  it("runs pull, ci --ignore-scripts, build:relay, pm2 restart, in order", () => {
    expect(UPDATE_STEPS).toEqual(["git pull --ff-only", "npm ci --ignore-scripts", "npm run build:relay", "npx pm2 restart teamsrelay"]);
    expect(updateCommand()).toBe(UPDATE_STEPS.join(" && "));
  });

  it("runs in the host's app directory with a timeout longer than a quick command", () => {
    const req = updateRequest(host);
    expect(req.command).toBe(updateCommand());
    expect(req.cwd).toBe("C:/teamsrelay/app");
    expect(req.timeout).toBeGreaterThan(600);
  });
});
