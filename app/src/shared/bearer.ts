import { createHash, timingSafeEqual } from "node:crypto";

// The token of an Authorization: Bearer header; "" without one
export const bearerToken = (header: string | null | undefined) => /^Bearer\s+(\S+)\s*$/i.exec(header ?? "")?.[1] ?? "";

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

// `given` is `expected`, compared by digests of one length: the time it takes tells nothing of either
export const sameToken = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected));
