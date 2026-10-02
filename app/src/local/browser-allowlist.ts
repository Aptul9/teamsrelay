import { toolError } from "@/shared/relay-sync";

// What the server may ask of the browser of this relay, checked here before Playwright MCP sees it: this computer runs
// the tools, so the line holds even against a server that forwards anything (docs/design/2026-10-01-relay-browser-mcp.md).
// The relay opens the MCP session itself: the socket carries tools/list and tools/call, nothing else.

// Navigation, tabs, reading and input. Left out: code run in the page or in the relay (browser_run_code_unsafe,
// browser_evaluate), files of this disk (browser_file_upload, browser_drop), requests with their headers, cookies and
// tokens of the profile (browser_network_requests, browser_network_request), browser_emulate_media, and every tool of
// the capabilities the relay does not turn on.
export const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_tabs",
  "browser_snapshot",
  "browser_find",
  "browser_take_screenshot",
  "browser_click",
  "browser_hover",
  "browser_drag",
  "browser_type",
  "browser_press_key",
  "browser_fill_form",
  "browser_select_option",
  "browser_handle_dialog",
  "browser_wait_for",
  "browser_resize",
  "browser_close",
  "browser_console_messages",
] as const;

const ALLOWED = new Set<string>(BROWSER_TOOLS);
// an argument that names a file of the relay disk: no use to a client on another computer
const FILE_ARGUMENT = "filename";

export type RpcId = number | string;
export type RpcRequest = { jsonrpc: "2.0"; id: RpcId; method: string; params?: Record<string, unknown> };
// a request that may go to Playwright MCP, or the answer the relay gives in its place (null: nothing to answer) and why
type Screened = { ok: true; request: RpcRequest } | { ok: false; reply: object | null; why: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is RpcId => (typeof v === "number" && Number.isFinite(v)) || typeof v === "string";

// refused with a JSON-RPC error of `code`, or, without one, with the failed result of a tool call
const refuse = (id: RpcId | null, why: string, code?: number): Screened => ({
  ok: false,
  why,
  reply: id === null ? null : { jsonrpc: "2.0", id, ...(code ? { error: { code, message: why } } : { result: toolError(why) }) },
});

// Why a page address is refused, null when it may be opened: web pages only (http, https), and none of this computer.
// Only the address given is read: a link in a page, or a name that resolves to a loopback address, still reaches it.
export function refusedUrl(url: unknown): string | null {
  if (typeof url !== "string") return "Not a valid URL";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "Not a valid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "Only http and https URLs are allowed";
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  const loopback = "The URL names this computer (a loopback address): not allowed";
  if (host === "localhost" || host.endsWith(".localhost")) return loopback;
  // the URL parser writes every IPv4 form (127.1, 0x7f.1, 2130706433) as four decimal numbers
  const v4 = /^(\d+)\.\d+\.\d+\.\d+$/.exec(host);
  if (v4 && (v4[1] === "127" || v4[1] === "0")) return loopback;
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    if (v6 === "::1" || v6 === "::") return loopback;
    // IPv4-mapped, which the parser writes in hex: ::ffff:7f00:1
    const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(v6);
    const first = mapped ? parseInt(mapped[1], 16) >> 8 : -1;
    if (first === 127 || first === 0) return loopback;
  }
  return null;
}

// A message from the server: a tools/list or an allowed tools/call goes on as it came; anything else gets its answer
// here and never reaches Playwright MCP
export function screenRequest(msg: unknown): Screened {
  if (!isObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || !isId(msg.id)) {
    const id = isObject(msg) && isId(msg.id) && typeof msg.method === "string" ? msg.id : null;
    return refuse(id, "Invalid request", -32600);
  }
  const { id, method } = msg;
  if (method === "tools/list") return { ok: true, request: msg as RpcRequest };
  if (method !== "tools/call") return refuse(id, `Method not allowed: ${method}`, -32601);
  const params = isObject(msg.params) ? msg.params : {};
  const name = params.name;
  if (typeof name !== "string") return refuse(id, "A tool name is needed");
  if (!ALLOWED.has(name)) return refuse(id, `${name} is not allowed on this relay`);
  const args = params.arguments ?? {};
  if (!isObject(args)) return refuse(id, "The arguments must be an object");
  if (FILE_ARGUMENT in args) return refuse(id, `${FILE_ARGUMENT} is not allowed: nothing is read from or written to the disk of the relay computer`);
  // the address of a new tab is read whatever the action given with it
  if (name === "browser_navigate" || (name === "browser_tabs" && args.url !== undefined)) {
    const why = refusedUrl(args.url);
    if (why) return refuse(id, why);
  }
  return { ok: true, request: msg as RpcRequest };
}

// The answer of Playwright MCP to tools/list as the server may see it: the allowed tools, without the file argument
export function screenTools(result: unknown): { tools: object[] } {
  const listed = isObject(result) && Array.isArray(result.tools) ? result.tools : [];
  const tools: object[] = [];
  for (const t of listed) {
    if (!isObject(t) || typeof t.name !== "string" || !ALLOWED.has(t.name)) continue;
    const schema = isObject(t.inputSchema) ? t.inputSchema : { type: "object" };
    const properties = isObject(schema.properties) ? { ...schema.properties } : undefined;
    if (properties) delete properties[FILE_ARGUMENT];
    const required = Array.isArray(schema.required) ? schema.required.filter((r) => r !== FILE_ARGUMENT) : undefined;
    tools.push({ ...t, inputSchema: { ...schema, ...(properties ? { properties } : {}), ...(required ? { required } : {}) } });
  }
  return { tools };
}
