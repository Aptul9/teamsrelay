// ed25519 keys for the embedded ssh2 server. ssh2 1.17.0 strips every leading 0x00 of the public key, so about 1 key
// in 256 from utils.generateKeyPairSync does not parse back. The helper must never hand one out, and a host key file
// that does not parse must be replaced instead of crashing the agent on every start.
import fs from "node:fs";
import path from "node:path";
import { utils } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEd25519 } from "@/fleet/ssh/keys";
import { loadOrCreateHostKey } from "@/fleet/ssh/server";
import { tempDir } from "../helpers";

type KeyPair = { private: string; public: string };
const sshKeygen = utils.generateKeyPairSync as (t: string) => KeyPair;
const parses = (key: string) => !(utils.parseKey(key) instanceof Error);

// a real malformed pair from ssh2 (public key with a leading 0x00), found by generating until one fails to parse
function malformedPair(): KeyPair {
  for (let i = 0; i < 10000; i++) {
    const pair = sshKeygen("ed25519");
    if (!parses(pair.private)) return pair;
  }
  throw new Error("no malformed ed25519 key in 10000 tries");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateEd25519", () => {
  it("generates again when ssh2 returns a key that does not parse", () => {
    const bad = malformedPair();
    const spy = vi.spyOn(utils, "generateKeyPairSync").mockReturnValueOnce(bad as never);
    const pair = generateEd25519();
    expect(parses(pair.private)).toBe(true);
    expect(parses(pair.public)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("loadOrCreateHostKey", () => {
  it("creates and persists a key when none exists", () => {
    const file = path.join(tempDir(), "state", "ssh_host_key");
    const key = loadOrCreateHostKey(file);
    expect(parses(key)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(key);
  });

  it("keeps a key on disk that parses", () => {
    const file = path.join(tempDir(), "ssh_host_key");
    const good = generateEd25519();
    fs.writeFileSync(file, good.private);
    expect(loadOrCreateHostKey(file)).toBe(good.private);
  });

  it("replaces a key on disk that does not parse and keeps the old file aside", () => {
    const file = path.join(tempDir(), "ssh_host_key");
    const bad = malformedPair();
    fs.writeFileSync(file, bad.private);
    const key = loadOrCreateHostKey(file);
    expect(parses(key)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(key);
    expect(fs.readFileSync(`${file}.bad`, "utf8")).toBe(bad.private);
  });
});
