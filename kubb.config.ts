import { defineConfig } from "@kubb/core";
import { pluginOas } from "@kubb/plugin-oas";
import { pluginTs } from "@kubb/plugin-ts";
import { pluginZod } from "@kubb/plugin-zod";

export default defineConfig({
  root: ".",
  input: {
    path: "./docs/plans/server/01-api-spec.yaml",
  },
  output: {
    path: "./src/gateway/generated",
    clean: true,
    barrelType: false,
  },
  plugins: [
    pluginOas({
      generators: [],
    }),
    pluginTs({
      output: {
        path: "./types.ts",    // single file
        barrelType: false,
      },
    }),
    pluginZod({
      output: {
        path: "./schemas.ts",  // single file
        barrelType: false,
      },
      typed: true,
      importPath: "zod",
    }),
  ],
});
