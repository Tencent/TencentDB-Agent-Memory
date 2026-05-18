import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    include: ["claude-code-plugin/tests/**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
