// cmdapi configuration from the environment. Every setting has a default; the one combination that must not start is a
// non-loopback bind with no token, which is an open shell handed to whoever finds the port.
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "@/agent/config";
import { loadCmdApiConfig } from "@/fleet/cmdapi/config";

describe("cmdapi config", () => {
  it("defaults to loopback, no token, a generous timeout", () => {
    const c = loadCmdApiConfig({});
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(8765);
    expect(c.token).toBe("");
    expect(c.isLoopback).toBe(true);
    expect(c.timeout).toBe(600);
    expect(c.cwd).toBeNull();
    expect(c.shell).toBeTruthy();
  });

  it("refuses a non-loopback bind with no token", () => {
    expect(() => loadCmdApiConfig({ CMDAPI_HOST: "0.0.0.0" })).toThrow(ConfigError);
  });

  it("allows a non-loopback bind once a token is set", () => {
    const c = loadCmdApiConfig({ CMDAPI_HOST: "0.0.0.0", CMDAPI_TOKEN: "x".repeat(32) });
    expect(c.isLoopback).toBe(false);
    // the url names loopback even when it binds every address, so a local health check has somewhere to go
    expect(c.url).toBe("http://127.0.0.1:8765");
  });

  it("takes the shell, cwd, timeout and output cap from the environment", () => {
    const c = loadCmdApiConfig({ CMDAPI_SHELL: "/bin/bash", CMDAPI_CWD: os.tmpdir(), CMDAPI_TIMEOUT: "30", CMDAPI_MAX_OUTPUT: "2048" });
    expect(c.shell).toBe("/bin/bash");
    expect(c.cwd).toBe(path.resolve(os.tmpdir()));
    expect(c.timeout).toBe(30);
    expect(c.maxOutput).toBe(2048);
  });

  it("refuses a cwd that is not a directory", () => {
    expect(() => loadCmdApiConfig({ CMDAPI_CWD: path.join(os.tmpdir(), "no-such-dir-" + Date.now()) })).toThrow(ConfigError);
  });

  it("refuses a non-numeric timeout", () => {
    expect(() => loadCmdApiConfig({ CMDAPI_TIMEOUT: "soon" })).toThrow(ConfigError);
  });
});
