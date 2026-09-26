// How the relay process ends, as a process: a small program that installs the stop handling of the relay
// (src/local/stop.ts) with a stop that says it ran, then fails the way asked in its argument.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../helpers";

const APP = path.resolve(__dirname, "../..");
let bundle = "";

const PROGRAM = `
import { onStop } from "@/local/stop";
onStop(async () => console.log("stop ran: browser closed, database closed"));
// the relay keeps running until something stops it
setInterval(() => undefined, 1000);
const how = process.argv[2];
if (how === "throw") setTimeout(() => { throw new Error("boom in a timer"); }, 50);
if (how === "reject") setTimeout(() => void Promise.reject(new Error("lost promise")), 50);
if (how === "message") setTimeout(() => process.emit("message", "shutdown", undefined), 50);
`;

beforeAll(async () => {
  const dir = tempDir("teamsrelay-stop-");
  fs.writeFileSync(path.join(dir, "program.ts"), PROGRAM);
  bundle = path.join(dir, "program.cjs");
  await build({
    absWorkingDir: APP,
    entryPoints: [path.join(dir, "program.ts")],
    tsconfig: path.join(APP, "tsconfig.json"),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile: bundle,
    logLevel: "warning",
  });
});

const run = (how: string) => spawnSync(process.execPath, [bundle, how], { encoding: "utf8", timeout: 20_000 });

describe("end of the relay process", () => {
  it("closes everything and exits 0 on the shutdown message of pm2", () => {
    const r = run("message");
    expect(r.stdout).toContain("stop ran");
    expect(r.status).toBe(0);
  });

  it("logs an error nothing caught, closes everything, and exits 1 for pm2 to start it again", () => {
    const r = run("throw");
    expect(r.stderr).toMatch(/^relay: uncaught error: boom in a timer$/m);
    expect(r.stdout).toContain("stop ran");
    expect(r.status).toBe(1);
  });

  it("does the same for a promise rejected with nobody waiting for it", () => {
    const r = run("reject");
    expect(r.stderr).toMatch(/^relay: unhandled rejection: lost promise$/m);
    expect(r.stdout).toContain("stop ran");
    expect(r.status).toBe(1);
  });
});
