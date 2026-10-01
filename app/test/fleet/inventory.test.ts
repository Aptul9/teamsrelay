// The fleet inventory: the hosts the fleet CLI knows, each with the hub VM it tunnels to, the VM loopback port its
// cmdapi is published on, its token, and where its teamsrelay checkout lives. Read from an untracked JSON file.
import { describe, expect, it } from "vitest";
import { hostByName, parseInventory, targets } from "@/fleet/cli/inventory";

const raw = {
  hosts: {
    zurich: { vm: "oracle-vm", port: 8766, token: "z".repeat(32), appDir: "C:/teamsrelay/app" },
    office: { vm: "oracle-vm", port: 8767, token: "o".repeat(32) },
  },
};

describe("inventory", () => {
  it("reads each host with its name filled from the key", () => {
    const hosts = parseInventory(raw);
    expect(hosts.map((h) => h.name).sort()).toEqual(["office", "zurich"]);
    const z = hosts.find((h) => h.name === "zurich")!;
    expect(z).toMatchObject({ vm: "oracle-vm", port: 8766, token: "z".repeat(32), appDir: "C:/teamsrelay/app" });
  });

  it("rejects a host missing a required field", () => {
    expect(() => parseInventory({ hosts: { bad: { vm: "oracle-vm", port: 8766 } } })).toThrow();
    expect(() => parseInventory({ hosts: { bad: { port: 8766, token: "t".repeat(32) } } })).toThrow();
  });

  it("looks a host up by name and names the known ones when it is missing", () => {
    const hosts = parseInventory(raw);
    expect(hostByName(hosts, "zurich").port).toBe(8766);
    expect(() => hostByName(hosts, "berlin")).toThrow(/zurich/);
  });

  it("resolves 'all' to every host and a name to just that one", () => {
    const hosts = parseInventory(raw);
    expect(targets(hosts, "all").length).toBe(2);
    expect(targets(hosts, "office").map((h) => h.name)).toEqual(["office"]);
    expect(() => targets(hosts, "berlin")).toThrow();
  });
});
