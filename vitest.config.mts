import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    // launching and closing Chrome for the page script tests took over 30 s once on a loaded laptop
    hookTimeout: 60000,
    // every Chrome suite starts its own browser: more at once than this and launches time out
    maxWorkers: 4,
  },
});
