// SFTP on the embedded ssh2 server (library mode): file transfer over the same SSH connection as exec/shell. Driven by
// a real ssh2 SFTP client against a temp directory: write a file, read it back, list the directory, remove it.
import fs from "node:fs";
import path from "node:path";
import { Client, utils } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSshServer } from "@/fleet/ssh/server";
import { tempDir } from "../helpers";

type KeyPair = { private: string; public: string };
const hostKey = (utils.generateKeyPairSync as (t: string) => KeyPair)("ed25519");
const good = (utils.generateKeyPairSync as (t: string) => KeyPair)("ed25519");

let server: { port: number; close: () => Promise<void> };
let dir: string;

beforeAll(async () => {
  dir = tempDir();
  server = await startSshServer({ port: 0, host: "127.0.0.1", hostKey: hostKey.private, authorizedKeys: [good.public], cwd: dir });
});

afterAll(async () => {
  await server.close();
});

function withSftp<T>(fn: (sftp: import("ssh2").SFTPWrapper, done: (v: T) => void, fail: (e: unknown) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () =>
        conn.sftp((err, sftp) => {
          if (err) return reject(err);
          fn(
            sftp,
            (v) => {
              conn.end();
              resolve(v);
            },
            (e) => {
              conn.end();
              reject(e);
            },
          );
        }),
      )
      .on("error", reject)
      .connect({ host: "127.0.0.1", port: server.port, username: "fleet", privateKey: good.private });
  });
}

describe("ssh server SFTP", () => {
  it("writes a file, reads it back, lists it, and removes it", async () => {
    const remote = path.join(dir, "up.txt");

    const written = await withSftp<string>((sftp, done, fail) => {
      sftp.writeFile(remote, "hello sftp", (e) => {
        if (e) return fail(e);
        sftp.readFile(remote, (e2, data) => {
          if (e2) return fail(e2);
          done(data.toString());
        });
      });
    });
    expect(written).toBe("hello sftp");
    expect(fs.existsSync(remote)).toBe(true);

    const names = await withSftp<string[]>((sftp, done, fail) => {
      sftp.readdir(dir, (e, list) => (e ? fail(e) : done(list.map((x) => x.filename))));
    });
    expect(names).toContain("up.txt");

    await withSftp<void>((sftp, done, fail) => sftp.unlink(remote, (e) => (e ? fail(e) : done(undefined))));
    expect(fs.existsSync(remote)).toBe(false);
  });
});
