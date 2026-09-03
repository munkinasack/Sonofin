import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 30_000,
    include: ["packages/database/test/d1-integration.integration.ts"],
    testTimeout: 30_000,
  },
});
