/**
 * memory-tdai CLI entry point.
 *
 * Registers the `memory-tdai` namespace under the OpenClaw CLI and
 * wires up all subcommands (currently: `seed`).
 *
 * Integration path:
 *   index.ts → api.registerCli() → registerMemoryTdaiCli()
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import type { SeedCommandOptions } from "../core/seed/types.js";

// ============================
// Context type
// ============================

/**
 * Minimal context needed by seed CLI commands.
 *
 * Derived from OpenClawPluginCliContext but scoped to what seed actually needs,
 * avoiding a hard dependency on the full plugin CLI context type.
 */
export interface SeedCliContext {
  /** OpenClaw config (for LLM calls in L1 extraction). */
  config: unknown;
  /** Raw plugin config (same shape as api.pluginConfig). */
  pluginConfig: unknown;
  /** State directory root (e.g. ~/.openclaw). */
  stateDir: string;
  /** Logger instance. */
  logger: {
    debug?: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
}

// ============================
// Top-level registration
// ============================

/**
 * Register all memory-tdai CLI subcommands under the given Commander program.
 *
 * This function is called by the plugin's `api.registerCli()` registrar.
 * It creates the `memory-tdai` namespace and delegates to individual
 * command registrars.
 *
 * @param program - The `memory-tdai` Commander command (already created by the registrar)
 * @param ctx - CLI context with config, state dir, and logger
 */
export function registerMemoryTdaiCli(program: any, ctx: SeedCliContext): void {
  program
    .command("seed")
    .description("Seed historical conversation data into the memory pipeline (L0 → L1)")
    .requiredOption("--input <file>", "Path to input JSON file")
    .option("--output-dir <dir>", "Output directory for pipeline data (default: auto-generated)")
    .option("--session-key <key>", "Fallback session key when input lacks one")
    .option("--config <file>", "Path to memory-tdai config override file (JSON, deep-merged on top of current plugin config)")
    .option("--strict-round-role", "Require each round to have both user and assistant messages", false)
    .option("--yes", "Skip interactive confirmations (e.g. timestamp auto-fill)", false)
    .addHelpText("after", `
Examples:
  openclaw memory-tdai seed --input conversations.json
  openclaw memory-tdai seed --input data.json --output-dir ./seed-output --strict-round-role
  openclaw memory-tdai seed --input data.json --config ./seed-config.json
  openclaw memory-tdai seed --input data.json --yes
`)
    .action(async (rawOpts: Record<string, unknown>) => {
      const opts: SeedCommandOptions = {
        input: rawOpts.input as string,
        outputDir: rawOpts.outputDir as string | undefined,
        sessionKey: rawOpts.sessionKey as string | undefined,
        strictRoundRole: rawOpts.strictRoundRole === true,
        yes: rawOpts.yes === true,
        configFile: rawOpts.config as string | undefined,
      };

      const seedModule = await loadSeedCommandModule();
      await seedModule.runSeedCommand(opts, ctx);
    });

  // Future: registerQueryCommand(program, ctx);
  // Future: registerStatsCommand(program, ctx);
}

async function loadSeedCommandModule(): Promise<{
  runSeedCommand: (opts: SeedCommandOptions, ctx: SeedCliContext) => Promise<void>;
}> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "commands", "seed.ts"),
    path.join(here, "..", "src", "cli", "commands", "seed.ts"),
    path.join(process.cwd(), "src", "cli", "commands", "seed.ts"),
  ];
  const seedPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!seedPath) {
    throw new Error("Unable to locate src/cli/commands/seed.ts");
  }
  return tsImport(pathToFileURL(seedPath).href, import.meta.url) as Promise<{
    runSeedCommand: (opts: SeedCommandOptions, ctx: SeedCliContext) => Promise<void>;
  }>;
}
