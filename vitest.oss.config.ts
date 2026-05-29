/**
 * Open-source vitest config — used by the public CI pipeline when building
 * without the private src/integrations/ submodule.
 *
 * Differences from vitest.config.ts:
 *   1. Excludes src/integrations/** test files entirely.
 *   2. Excludes the small set of core tests that vi.mock() paths inside
 *      src/integrations/ (e.g. store/factory.test.ts uses
 *      vi.mock("../../integrations/tcvdb/tcvdb.js")). These tests verify the
 *      tcvdb/redis/shark integration glue logic on core's side and cannot run
 *      when the integration files themselves are absent from disk.
 *
 * Internal builds keep using vitest.config.ts which runs everything.
 *
 * Usage (open-source CI):
 *   pnpm vitest run -c vitest.oss.config.ts
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    exclude: [
      "dist/**",
      "node_modules/**",
      "**/*.e2e.test.ts",
      // Integration source/test directory — not present in OSS build.
      "src/integrations/**",
      // Core tests that mock integration module paths — cannot resolve when
      // the integrations directory is absent.
      "src/core/instance-config-provider.test.ts",
      "src/core/state/state-backend.test.ts",
      // Note: src/core/store/factory.test.ts and store-pool.test.ts no longer
      // mock integration paths after TCVDB moved back to src/core/store/.
      // E2E suites that talk to multi-instance shark/redis backends.
      "src/services/multi-instance-e2e.test.ts",
      "src/services/services-extra.test.ts",
      "src/services/e2e-full.test.ts",
      // hermes-e2e fixture starts the gateway in service mode with
      // storeBackend=tcvdb; without the integration files on disk the gateway
      // boots in degraded mode and the /health assertion fails. Internal CI
      // still runs it via vitest.config.ts.
      "src/services/hermes-e2e.test.ts",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts", "index.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/integrations/**",
        "dist/**",
        "node_modules/**",
      ],
    },
  },
});
