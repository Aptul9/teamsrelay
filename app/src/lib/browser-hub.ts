// The hub of the relay browsers (src/server/browser-hub.ts) as the routes reach it. The hub is loaded before Next.js
// (dist/call-audio.cjs) and Turbopack copies module state per chunk: the one handle both see is on globalThis.

export const BROWSER_HUB_KEY = "__teamsRelayBrowserHub";

// a tool of Playwright MCP as the relay lists it, after its allowlist
export type BrowserTool = { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> };
// the answer of a tool call: MCP content (text, images), isError on a failure
export type ToolResult = { content: unknown[]; isError?: boolean; [key: string]: unknown };

export type BrowserHub = {
  // tools of the relay of the account while its socket is open, null otherwise
  tools(slot: number): BrowserTool[] | null;
  // one call, after the calls of that account already waiting; a failure is a tool error
  call(slot: number, name: string, args: Record<string, unknown>): Promise<ToolResult>;
};

export function browserHub(): BrowserHub | null {
  return ((globalThis as Record<string, unknown>)[BROWSER_HUB_KEY] as BrowserHub | undefined) ?? null;
}
