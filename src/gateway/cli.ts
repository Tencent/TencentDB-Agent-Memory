#!/usr/bin/env node
/**
 * `tdai-memory-gateway` — standalone Gateway daemon entry.
 *
 * Exposed as a `bin` in package.json so users can run:
 *   npx tdai-memory-gateway           # from a project that depends on the package
 *   tdai-memory-gateway               # after `npm install -g @tencentdb-agent-memory/memory-tencentdb`
 *
 * Reads config from environment variables (see src/gateway/config.ts):
 *   TDAI_TOKEN_PATH     path to a 0600 file holding the Bearer token (preferred —
 *                       avoids leaking the token via /proc/<pid>/environ / `ps -E`)
 *   TDAI_GATEWAY_TOKEN  Bearer token (fallback for Hermes-style direct env passing)
 *   TDAI_GATEWAY_PORT   port to bind (default 8420)
 *   TDAI_GATEWAY_HOST   bind host (default 127.0.0.1). Non-loopback values require
 *                       TDAI_GATEWAY_ALLOW_REMOTE=1 to opt in (defence in depth).
 *   TDAI_DATA_DIR       data root
 *   TDAI_CC_PID         (optional) parent process pid; daemon self-exits when it dies
 *
 * Designed for use by host-agnostic plugins (Claude Code, Codex CLI) that spawn
 * the Gateway as a sidecar without bundling npm dependencies.
 */

import { readFileSync } from "node:fs";
import { TdaiGateway } from "./server.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);

function assertSafeHost(): void {
  const host = process.env.TDAI_GATEWAY_HOST?.trim();
  if (!host) return;
  if (LOOPBACK_HOSTS.has(host)) return;
  if (process.env.TDAI_GATEWAY_ALLOW_REMOTE === "1") return;
  process.stderr.write(
    `tdai-memory-gateway: refusing to bind TDAI_GATEWAY_HOST=${host} (non-loopback). ` +
      `Set TDAI_GATEWAY_ALLOW_REMOTE=1 to opt in.\n`,
  );
  process.exit(2);
}

function loadTokenFromFile(): void {
  const tokenPath = process.env.TDAI_TOKEN_PATH;
  if (!tokenPath) return;
  try {
    const token = readFileSync(tokenPath, "utf-8").trim();
    if (!token) {
      process.stderr.write(`tdai-memory-gateway: TDAI_TOKEN_PATH=${tokenPath} is empty\n`);
      process.exit(2);
    }
    // Set on the in-process env object only — this does NOT mutate the
    // execve() environment block, so /proc/<pid>/environ / `ps -E` won't
    // expose the token.
    process.env.TDAI_GATEWAY_TOKEN = token;
  } catch (err) {
    process.stderr.write(
      `tdai-memory-gateway: failed to read TDAI_TOKEN_PATH=${tokenPath}: ${String(err)}\n`,
    );
    process.exit(2);
  }
}

async function main(): Promise<void> {
  assertSafeHost();
  loadTokenFromFile();
  const gateway = new TdaiGateway();
  await gateway.start();

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await Promise.race([
        gateway.stop(),
        new Promise<void>((r) => setTimeout(r, 5_000)),
      ]);
    } catch {
      // best effort
    }
    process.exit(reason === "error" ? 1 : 0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const ccPid = parseInt(process.env.TDAI_CC_PID ?? "0", 10);
  if (Number.isFinite(ccPid) && ccPid > 0) {
    const timer = setInterval(() => {
      try {
        process.kill(ccPid, 0);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ESRCH") {
          clearInterval(timer);
          void shutdown("parent-exit");
        }
      }
    }, 60_000);
    timer.unref();
  }
}

main().catch((err) => {
  process.stderr.write(`tdai-memory-gateway failed: ${String(err)}\n`);
  process.exit(1);
});
