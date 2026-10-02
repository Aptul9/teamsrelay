import { appDb, logBrowserAction, slotRow, slotsOf } from "../appdb";
import { browserHub, type BrowserTool, type ToolResult } from "../browser-hub";
import { toolError, urlHost } from "@/shared/relay-sync";
import { ToolError } from "./tools";

// The browser of the relays of a user for its MCP clients (docs/design/2026-10-01-relay-browser-mcp.md): the tools of
// Playwright MCP that the relay lets through (its allowlist), offered on /mcp to an OAuth token only, each with one more
// argument, account. A call checks the account in the order of the spec, goes to the hub without account, and its
// answer comes back as it came; each one is written to browser_actions.

// The accounts of the user whose relay is connected with its browser on, and not switched off in Settings
export function browserAccounts(userId: string): number[] {
  const hub = browserHub();
  if (!hub) return [];
  return slotsOf(appDb(), userId)
    .filter((s) => s.relay && !s.stopped && !s.browser_off && hub.tools(s.slot))
    .map((s) => s.slot);
}

// The tools of those relays, each once: the first relay that lists a name gives its schema
export function browserTools(slots: number[]): BrowserTool[] {
  const hub = browserHub();
  const seen = new Map<string, BrowserTool>();
  for (const slot of slots) for (const t of hub?.tools(slot) ?? []) if (!seen.has(t.name)) seen.set(t.name, t);
  return [...seen.values()];
}

// The input schema of a relay tool with the account to run it on, required, among the given slots
export function withAccount(schema: Record<string, unknown>, slots: number[]): Record<string, unknown> {
  // the JSON Schema dialect Playwright MCP names is the default of the validator anyway
  const rest = Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$schema"));
  const properties = (rest.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(rest.required) ? (rest.required as string[]) : [];
  return {
    ...rest,
    type: "object",
    properties: {
      account: {
        type: "integer",
        description: `Slot number of the Teams account whose relay computer runs the browser, as list_accounts gives it: ${slots.join(", ")}`,
      },
      ...properties,
    },
    required: ["account", ...required.filter((r) => r !== "account")],
  };
}


// One call of a browser tool by an OAuth client of the user. Checks, in order: the user owns the account (an account of
// someone else is not found, and nothing is written under it), it is an account on another computer, the owner did
// not switch its browser off, its relay is connected with the browser on. Then the hub runs it on that relay.
export async function callBrowserTool(o: { userId: string; clientId: string; slot: unknown; name: string; args: Record<string, unknown> }): Promise<ToolResult> {
  const slot = o.slot;
  if (typeof slot !== "number" || !Number.isInteger(slot)) throw new ToolError("account: the slot number of the account, as list_accounts gives it");
  const row = slotRow(appDb(), slot);
  if (!row || row.owner_id !== o.userId) throw new ToolError("Account not found");
  const log = (outcome: string) => logBrowserAction(appDb(), { userId: o.userId, clientId: o.clientId, slot, tool: o.name, host: urlHost(o.args), outcome });
  const refuse = (outcome: string, text: string) => {
    log(outcome);
    return toolError(text);
  };
  if (!row.relay) return refuse("not-relay", `Account ${slot} is not on another computer: only the relay of an account on another computer has a browser for AI clients`);
  if (row.stopped) return refuse("stopped", `Account ${slot} is stopped: start it first`);
  if (row.browser_off) return refuse("off", `The browser of account ${slot} is switched off for AI clients: its owner turns it on again in Settings`);
  const hub = browserHub();
  const tools = hub?.tools(slot);
  if (!hub || !tools) return refuse("offline", `The relay of account ${slot} is not connected with its browser on (RELAY_BROWSER=1 in its relay.env)`);
  if (!tools.some((t) => t.name === o.name)) return refuse("refused", `${o.name} is not a tool of the relay of account ${slot}`);
  const result = await hub.call(slot, o.name, o.args);
  log(result.isError ? "error" : "ok");
  return result;
}
