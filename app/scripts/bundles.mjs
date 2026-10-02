// The Node bundles of the app (dist/*.cjs), one esbuild build each with the same options: `node scripts/bundles.mjs`
// builds them all, `node scripts/bundles.mjs relay agent` those named. The process tests build the same bundles.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// entry, output, the packages that stay outside (native, or loaded only when used), source map
export const BUNDLES = {
  agent: { entry: "src/agent/main.ts", out: "dist/agent.cjs", external: ["playwright-core", "better-sqlite3"], sourcemap: true },
  supervisor: { entry: "src/supervisor/main.ts", out: "dist/supervisor.cjs" },
  relay: { entry: "src/local/main.ts", out: "dist/relay.cjs", external: ["playwright-core", "better-sqlite3", "@playwright/mcp"] },
  hub: { entry: "src/server/call-audio-preload.ts", out: "dist/call-audio.cjs", external: ["bufferutil", "utf-8-validate"] },
  cmdapi: { entry: "src/fleet/cmdapi/main.ts", out: "dist/cmdapi.cjs" },
  fleet: { entry: "src/fleet/cli/main.ts", out: "dist/fleet.cjs" },
  "fleet-agent": { entry: "src/fleet/agent/main.ts", out: "dist/fleet-agent.cjs", external: ["ssh2", "better-sqlite3"] },
};

// The esbuild options of bundle `name`, written to `outfile` (its own place by default)
/** @param {string} name @param {string} [outfile] @returns {import("esbuild").BuildOptions} */
export function bundleOptions(name, outfile) {
  const b = BUNDLES[name];
  if (!b) throw new Error(`unknown bundle ${name}: ${Object.keys(BUNDLES).join(", ")}`);
  return {
    absWorkingDir: APP,
    entryPoints: [b.entry],
    outfile: outfile ?? path.join(APP, b.out),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    external: b.external ?? [],
    sourcemap: b.sourcemap ?? false,
    logLevel: "warning",
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const names = process.argv.slice(2);
  for (const name of names.length ? names : Object.keys(BUNDLES)) await build(bundleOptions(name));
}
