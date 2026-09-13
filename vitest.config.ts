import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, ".") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The synthetic capture harness warps multi-megapixel buffers in plain JS.
    testTimeout: 30000,
  },
});
