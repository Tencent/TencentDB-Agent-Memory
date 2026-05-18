import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./lib/hook.ts"],
  outDir: "./dist/lib",
  format: "esm",
  platform: "node",
  clean: true,
  fixedExtension: true,
  dts: false,
  sourcemap: false,
  // Plugin only bundles its own hook entry (no npm deps in hook.ts).
  // The actual Gateway daemon is spawned via `npx tdai-memory-gateway`
  // from the user's globally installed @tencentdb-agent-memory/memory-tencentdb.
  deps: {
    neverBundle: (id) => id.startsWith("node:"),
  },
});
