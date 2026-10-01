// The fleet inventory: the relay hosts the CLI can reach, read from an untracked JSON file (tokens live in it, so it is
// never committed). Each host names the hub VM it tunnels to, the VM loopback port its cmdapi is published on, its
// bearer token, and the teamsrelay app directory on the host (where an update runs).
import fs from "node:fs";
import { z } from "zod";

const Host = z.object({
  vm: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  token: z.string(),
  // teamsrelay app/ on the host; the default suits a checkout in the home directory
  appDir: z.string().default("teamsrelay/app"),
});

const Inventory = z.object({ hosts: z.record(z.string(), Host) });

export interface FleetHost {
  name: string;
  vm: string;
  port: number;
  token: string;
  appDir: string;
}

export function parseInventory(obj: unknown): FleetHost[] {
  const r = Inventory.safeParse(obj);
  if (!r.success) throw new Error(`inventory: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return Object.entries(r.data.hosts).map(([name, h]) => ({ name, ...h }));
}

export function loadInventory(file: string): FleetHost[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`inventory not found: ${file}`);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error(`inventory is not valid JSON: ${file}`);
  }
  return parseInventory(obj);
}

export function hostByName(hosts: FleetHost[], name: string): FleetHost {
  const found = hosts.find((h) => h.name === name);
  if (!found) throw new Error(`unknown host ${name}; known: ${hosts.map((h) => h.name).join(", ") || "(none)"}`);
  return found;
}

// A selector is a host name or "all"
export function targets(hosts: FleetHost[], selector: string): FleetHost[] {
  if (selector === "all") return hosts;
  return [hostByName(hosts, selector)];
}
