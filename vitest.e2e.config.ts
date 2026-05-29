import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    include: ["**/*.e2e.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    clearMocks: true,
    restoreMocks: true,
  },
});
