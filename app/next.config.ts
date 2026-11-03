import fs from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// Paths a status page may not take (src/lib/status-pages.ts): every top-level entry of src/app and public at build time
const reserved = ["src/app", "public"].flatMap((d) => fs.readdirSync(path.join(__dirname, d)));

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["better-sqlite3"],
  env: { STATUS_RESERVED: reserved.join(",") },
};

export default nextConfig;
