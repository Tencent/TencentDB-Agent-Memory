import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { parseConfig, TdaiCore } from "./index.js";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("library mode public exports", () => {
  it("exposes host-neutral core and config subpaths", () => {
    expect(packageJson.exports).toMatchObject({
      "./core": {
        import: "./dist/core/index.mjs",
        types: "./dist/core/index.d.mts",
      },
      "./config": {
        import: "./dist/config.mjs",
        types: "./dist/config.d.mts",
      },
    });
  });

  it("keeps TdaiCore and parseConfig available from the core barrel", () => {
    expect(typeof TdaiCore).toBe("function");
    expect(typeof parseConfig).toBe("function");
    expect(parseConfig({ extraction: { enabled: false } }).extraction.enabled).toBe(false);
  });

  it("documents TdaiCore construction through the HostAdapter contract", () => {
    const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
    const readmeCn = readFileSync(resolve(repoRoot, "README_CN.md"), "utf8");

    expect(readme).not.toContain("llmRunnerFactory,");
    expect(readmeCn).not.toContain("llmRunnerFactory,");
    expect(readme).toContain("HostAdapter.getLLMRunnerFactory()");
    expect(readmeCn).toContain("HostAdapter.getLLMRunnerFactory()");
  });
});
