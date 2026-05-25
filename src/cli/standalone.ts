import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { registerMemoryTdaiCli } from "./index.js";

const logger = {
  debug: process.env.MEMORY_TDAI_DEBUG ? (message: string) => console.debug(message) : undefined,
  info: (message: string) => console.info(message),
  warn: (message: string) => console.warn(message),
  error: (message: string) => console.error(message),
};

const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw");

const program = new Command();
program
  .name("memory-tdai")
  .description("TencentDB Agent Memory CLI")
  .showHelpAfterError();

registerMemoryTdaiCli(program, {
  config: {},
  pluginConfig: {},
  stateDir,
  logger,
});

await program.parseAsync(process.argv);
