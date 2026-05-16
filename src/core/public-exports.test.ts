import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { parseConfig, TdaiCore } from "./index.js";

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
});
