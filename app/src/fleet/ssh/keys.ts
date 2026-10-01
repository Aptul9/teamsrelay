// ed25519 key pairs for the embedded ssh2 server and its tests.
import { utils } from "ssh2";

export type KeyPair = { private: string; public: string };

const ATTEMPTS = 16;

export function parsesAsKey(key: string): boolean {
  return !(utils.parseKey(key) instanceof Error);
}

// ssh2 1.17.0 strips every leading 0x00 byte of the ed25519 public key, so about 1 pair in 256 comes out 1 byte short
// and parseKey (and new Server) reject it as a malformed OpenSSH key. Generate again until the private key parses; the
// public key comes from the same bytes, so it is then whole too.
export function generateEd25519(): KeyPair {
  for (let i = 0; i < ATTEMPTS; i++) {
    const pair = (utils.generateKeyPairSync as (t: string) => KeyPair)("ed25519");
    if (parsesAsKey(pair.private)) return pair;
  }
  throw new Error(`fleet ssh: no parseable ed25519 key in ${ATTEMPTS} attempts`);
}
