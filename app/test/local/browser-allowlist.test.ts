// What the relay lets through to Playwright MCP, and what it shows of it: the relay runs the tools, so it holds the line
// even against a server that forwards anything.
import { describe, expect, it } from "vitest";
import { BROWSER_TOOLS, refusedUrl, screenRequest, screenTools } from "@/local/browser-allowlist";

const call = (name: string, args: Record<string, unknown> = {}, id: number | string = 7) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

// a refused tools/call answers a tool error with the same id, and nothing goes to Playwright MCP
function refusedCall(msg: unknown, id: number | string = 7) {
  const r = screenRequest(msg);
  expect(r.ok, JSON.stringify(msg)).toBe(false);
  if (r.ok) throw new Error("passed");
  expect(r.reply).toMatchObject({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text" }] } });
  return (r.reply as { result: { content: { text: string }[] } }).result.content[0].text;
}

// plain arguments each allowed tool takes
const PLAIN: Record<string, Record<string, unknown>> = {
  browser_navigate: { url: "https://www.wikipedia.org/" },
  browser_navigate_back: {},
  browser_tabs: { action: "list" },
  browser_snapshot: {},
  browser_find: { text: "Search" },
  browser_take_screenshot: { scale: "css" },
  browser_click: { target: "e12" },
  browser_hover: { target: "e12" },
  browser_drag: { startTarget: "e1", endTarget: "e2" },
  browser_type: { target: "e3", text: "teleprinter", submit: true },
  browser_press_key: { key: "Enter" },
  browser_fill_form: { fields: [{ name: "q", type: "textbox", target: "e3", value: "x" }] },
  browser_select_option: { target: "e4", values: ["a"] },
  browser_handle_dialog: { accept: true },
  browser_wait_for: { text: "Results" },
  browser_resize: { width: 1280, height: 800 },
  browser_close: {},
  browser_console_messages: { level: "error" },
};

describe("tools/call", () => {
  it("lets every allowed tool through with plain arguments, unchanged", () => {
    expect([...BROWSER_TOOLS].sort()).toEqual(Object.keys(PLAIN).sort());
    for (const name of BROWSER_TOOLS) {
      const msg = call(name, PLAIN[name]);
      expect(screenRequest(msg), name).toEqual({ ok: true, request: msg });
    }
  });

  it("refuses every other tool of Playwright MCP, and unknown names, naming the tool", () => {
    for (const name of ["browser_run_code_unsafe", "browser_evaluate", "browser_file_upload", "browser_drop", "browser_network_requests", "browser_network_request", "browser_emulate_media", "browser_install", "browser_pdf_save", "browser_cookie_list", "nonsense"]) {
      expect(refusedCall(call(name, { code: "process.exit()", function: "() => 1", paths: ["C:/x"] })), name).toContain(name);
    }
  });

  it("refuses filename on any tool: no path of the relay disk for a remote client", () => {
    for (const name of ["browser_take_screenshot", "browser_snapshot", "browser_console_messages", "browser_find", "browser_navigate"]) {
      expect(refusedCall(call(name, { ...PLAIN[name], filename: "out.png" })), name).toMatch(/filename/);
    }
    // present but empty counts too
    refusedCall(call("browser_snapshot", { filename: undefined }));
  });

  it("refuses arguments that are not an object, and a tool name that is not a string", () => {
    refusedCall({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "browser_snapshot", arguments: ["x"] } });
    refusedCall({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: 12 } });
    refusedCall({ jsonrpc: "2.0", id: 7, method: "tools/call" });
  });

  it("takes http and https pages only, on no loopback host, in browser_navigate and in a new tab", () => {
    const bad = [
      "file:///C:/Users/x/secret.txt",
      "chrome://settings",
      "edge://settings",
      "about:blank",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "view-source:https://example.com",
      "ftp://example.com/",
      "http://localhost:8787/",
      "http://LOCALHOST/",
      "http://localhost./",
      "http://relay.localhost/",
      "http://127.0.0.1/",
      "http://127.1/",
      "http://0x7f.1/",
      "http://2130706433/",
      "http://127.255.255.254:9341/json",
      "http://0.0.0.0:8787/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[0:0:0:0:0:0:0:1]/",
      "not a url",
      "",
    ];
    for (const url of bad) {
      expect(refusedCall(call("browser_navigate", { url })), url).toMatch(/URL|address/i);
      refusedCall(call("browser_tabs", { action: "new", url }));
      // the url of browser_tabs is read whatever the action
      refusedCall(call("browser_tabs", { action: "select", index: 0, url }));
    }
    refusedCall(call("browser_navigate", { url: 42 }));
    for (const url of ["https://www.wikipedia.org/", "http://example.com/a?b=c#d", "https://192.168.1.10/", "https://duckduckgo.com/?q=localhost"]) {
      expect(screenRequest(call("browser_navigate", { url })).ok, url).toBe(true);
      expect(screenRequest(call("browser_tabs", { action: "new", url })).ok, url).toBe(true);
    }
    expect(screenRequest(call("browser_tabs", { action: "new" })).ok).toBe(true);
  });

  it("keeps the id of the request in the answer, string ids included", () => {
    refusedCall(call("browser_evaluate", {}, "abc"), "abc");
  });
});

describe("other messages", () => {
  it("lets tools/list through", () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    expect(screenRequest(msg)).toEqual({ ok: true, request: msg });
  });

  it("refuses every other method with a JSON-RPC error: the relay opens the session itself", () => {
    for (const method of ["initialize", "ping", "resources/list", "prompts/list", "completion/complete", "logging/setLevel", "tools/call/x"]) {
      const r = screenRequest({ jsonrpc: "2.0", id: 3, method, params: {} });
      expect(r, method).toEqual({ ok: false, why: `Method not allowed: ${method}`, reply: { jsonrpc: "2.0", id: 3, error: { code: -32601, message: `Method not allowed: ${method}` } } });
    }
  });

  it("answers nothing to a notification or a message with no id, and lets none through", () => {
    for (const msg of [{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", method: "tools/call", params: { name: "browser_snapshot" } }]) {
      expect(screenRequest(msg)).toEqual({ ok: false, why: "Invalid request", reply: null });
    }
  });

  it("refuses what is not a JSON-RPC request", () => {
    for (const msg of [null, "tools/list", 5, [], { id: 1 }, { jsonrpc: "2.0", id: 1, method: 5 }, { jsonrpc: "2.0", id: { a: 1 }, method: "tools/list" }]) {
      expect(screenRequest(msg).ok, JSON.stringify(msg)).toBe(false);
    }
  });
});

describe("the list of tools", () => {
  const tool = (name: string, properties: Record<string, unknown>, required: string[] = []) => ({ name, description: name, inputSchema: { type: "object", properties, required } });

  it("shows the allowed tools only, without filename", () => {
    const listed = {
      tools: [
        tool("browser_navigate", { url: { type: "string" } }, ["url"]),
        tool("browser_run_code_unsafe", { code: { type: "string" }, filename: { type: "string" } }),
        tool("browser_take_screenshot", { type: { type: "string" }, filename: { type: "string" }, scale: { type: "string" } }, ["scale", "filename"]),
        tool("browser_evaluate", { function: { type: "string" } }, ["function"]),
        tool("browser_snapshot", { filename: { type: "string" } }),
      ],
    };
    const shown = screenTools(listed);
    expect(shown.tools.map((t) => (t as { name: string }).name)).toEqual(["browser_navigate", "browser_take_screenshot", "browser_snapshot"]);
    expect(shown.tools[1]).toEqual(tool("browser_take_screenshot", { type: { type: "string" }, scale: { type: "string" } }, ["scale"]));
    expect(shown.tools[2]).toEqual(tool("browser_snapshot", {}));
    // the answer of Playwright MCP is left as it was
    expect(listed.tools[2].inputSchema.properties).toHaveProperty("filename");
  });

  it("gives an empty list for an answer of another shape", () => {
    for (const r of [null, {}, { tools: "x" }, { tools: [null, 5, { name: 3 }] }]) expect(screenTools(r)).toEqual({ tools: [] });
  });
});

describe("refusedUrl", () => {
  it("names why, or null for a public web page", () => {
    expect(refusedUrl("https://example.com/")).toBeNull();
    expect(refusedUrl("file:///etc/passwd")).toMatch(/http/);
    expect(refusedUrl("http://127.0.0.1/")).toMatch(/computer/);
  });
});
