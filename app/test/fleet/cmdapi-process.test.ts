// The cmdapi bundle as a real process: build dist/cmdapi.cjs with esbuild, run it, and drive it over HTTP. Proves the
// bundle runs (no missing externals, config and server wired) and the whole request path works end to end, not each
// piece in isolation.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { build } from "esbuild";
import { bundleOptions } from "../../scripts/bundles.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../helpers";

const TOKEN = "t".repeat(32);
let proc: ChildProcess | null = null;
let url = "";

beforeAll(async () => {
  const dir = tempDir();
  const bundle = path.join(dir, "cmdapi.cjs");
  await build(bundleOptions("cmdapi", bundle));

  proc = spawn(process.execPath, [bundle], {
    cwd: dir,
    env: { ...process.env, CMDAPI_HOST: "127.0.0.1", CMDAPI_PORT: "0", CMDAPI_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  url = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`cmdapi did not come up; saw: ${buf}`)), 15000);
    proc!.stdout!.on("data", (c: Buffer) => {
      buf += c;
      const m = buf.match(/listening on (http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc!.once("error", reject);
  });
}, 30000);

afterAll(() => {
  proc?.kill();
});

describe("cmdapi process", () => {
  it("answers /health", async () => {
    const res = await fetch(`${url}/health`);
    expect((await res.json()).ok).toBe(true);
  });

  it("runs a command with the token and refuses it without", async () => {
    const noAuth = await fetch(`${url}/command`, { method: "POST", body: "echo bundletest" });
    expect(noAuth.status).toBe(401);

    const ok = await fetch(`${url}/command`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "echo bundletest" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).stdout).toContain("bundletest");
  });
});
