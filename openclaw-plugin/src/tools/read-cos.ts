/**
 * tdai_read_cos tool — reads memory pipeline artifacts (persona.md,
 * scene_blocks/*.md, ...) by relative path via the SDK's `client.readFile`.
 */

import type { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts";

interface Logger {
  debug?: (msg: string) => void;
  warn: (msg: string) => void;
}

export async function handleReadCos(
  client: MemoryClient,
  params: { path: string },
  logger?: Logger,
) {
  const { path } = params;

  if (!path?.trim()) {
    return { content: [{ type: "text" as const, text: "Path cannot be empty." }] };
  }

  // Security: reject path traversal
  if (path.includes("..") || path.startsWith("/")) {
    return { content: [{ type: "text" as const, text: `Invalid path: "${path}"` }] };
  }

  try {
    logger?.debug?.(`[read-cos] read: "${path}"`);
    const content = await client.readFile(path);
    logger?.debug?.(`[read-cos] ✅ "${path}" (${content.length} chars)`);
    return { content: [{ type: "text" as const, text: content }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn(`[read-cos] Failed to read "${path}": ${msg}`);
    return { content: [{ type: "text" as const, text: `Failed to read file: ${msg}` }] };
  }
}
