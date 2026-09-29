// scripts/fcm-check.mjs refuses Firebase files that do not belong together before it asks Google anything: a wrong
// file as the service account key would stop the agents, two projects would have the server remove every phone.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

const SCRIPT = path.resolve(__dirname, "../scripts/fcm-check.mjs");
const dir = tempDir();
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

const googleServices = (project: string, pkg = "io.github.aptul9.teamsrelay") => ({
  project_info: { project_id: project, project_number: "123456789012" },
  client: [{ client_info: { android_client_info: { package_name: pkg } } }],
});
const serviceAccount = (project: string) => ({
  type: "service_account",
  project_id: project,
  client_email: `relay@${project}.iam.gserviceaccount.com`,
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

function check(gs: object, sa: object) {
  const a = path.join(dir, `${crypto.randomUUID()}-gs.json`);
  const b = path.join(dir, `${crypto.randomUUID()}-sa.json`);
  fs.writeFileSync(a, JSON.stringify(gs));
  fs.writeFileSync(b, JSON.stringify(sa));
  const r = spawnSync(process.execPath, [SCRIPT, a, b], { encoding: "utf8", timeout: 20_000 });
  return { status: r.status, out: r.stdout };
}

describe("the check of the Firebase files", () => {
  it("refuses a key of another Firebase project", () => {
    const r = check(googleServices("teamsrelay-a"), serviceAccount("teamsrelay-b"));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL: two Firebase projects, teamsrelay-a and teamsrelay-b/);
  });

  it("refuses a google-services.json without the app of TeamsRelay", () => {
    const r = check(googleServices("teamsrelay-a", "com.example.other"), serviceAccount("teamsrelay-a"));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL: google-services.json has no Android app io\.github\.aptul9\.teamsrelay/);
  });

  it("refuses google-services.json given as the service account key, and prints no key", () => {
    const r = check(googleServices("teamsrelay-a"), googleServices("teamsrelay-a"));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL: the second file is no service account key/);
    const withKey = check(googleServices("teamsrelay-a"), serviceAccount("teamsrelay-b"));
    expect(withKey.out).not.toMatch(/PRIVATE KEY/);
  });
});
