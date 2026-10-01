// The embedded ssh2 server (the no-admin shell into a relay host). Public-key auth only; an exec request runs the
// command through the same runner cmdapi uses. Driven by a real in-process ssh2 client: an authorized key runs a
// command, an unauthorized key is refused.
import { Client, utils } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSshServer } from "@/fleet/ssh/server";

type KeyPair = { private: string; public: string };
const hostKey = (utils.generateKeyPairSync as (t: string) => KeyPair)("ed25519");
const good = (utils.generateKeyPairSync as (t: string) => KeyPair)("ed25519");
const bad = (utils.generateKeyPairSync as (t: string) => KeyPair)("ed25519");

let server: { port: number; close: () => Promise<void> };

beforeAll(async () => {
  server = await startSshServer({ port: 0, host: "127.0.0.1", hostKey: hostKey.private, authorizedKeys: [good.public] });
});

afterAll(async () => {
  await server.close();
});

function exec(privateKey: string, command: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) return reject(err);
          let stdout = "";
          let code: number | null = null;
          stream
            .on("data", (d: Buffer) => (stdout += d))
            .on("exit", (c: number) => (code = c))
            .on("close", () => {
              conn.end();
              resolve({ code, stdout });
            });
        });
      })
      .on("error", reject)
      .connect({ host: "127.0.0.1", port: server.port, username: "fleet", privateKey });
  });
}

describe("ssh server", () => {
  it("runs a command for an authorized key", async () => {
    const r = await exec(good.private, "echo sshexectest");
    expect(r.stdout).toContain("sshexectest");
    expect(r.code).toBe(0);
  });

  it("refuses an unauthorized key", async () => {
    await expect(exec(bad.private, "echo nope")).rejects.toThrow();
  });
});
