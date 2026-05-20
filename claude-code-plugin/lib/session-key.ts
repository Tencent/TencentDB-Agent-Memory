/**
 * Compute a stable session key for a given working directory.
 *
 * Default: SHA-256 of the normalized absolute path, first 16 hex chars (64 bits).
 * Override: TDAI_SESSION_KEY env var, if non-empty.
 *
 * Used by hook handlers to partition memory by project rather than by
 * Claude Code session, so multiple cc terminals on the same project share
 * recall results.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function getSessionKey(cwd: string): string {
  const override = process.env.TDAI_SESSION_KEY;
  if (override && override.length > 0) {
    return override;
  }
  const normalized = resolve(cwd);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
