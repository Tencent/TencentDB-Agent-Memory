/**
 * Parse cc transcript jsonl files defensively. cc's transcript format is
 * NOT a documented stable API — fields may rename across versions. This
 * module returns null on any unexpected shape rather than throwing.
 */

import { readFile } from "node:fs/promises";

export interface TranscriptEntry {
  type: "user" | "assistant" | string;
  role: string;
  content: string;
  /** True when the raw message.content was an array (tool_result, skill
   *  output, multi-modal input).  Used by readAllTurns to avoid treating
   *  injected system messages as real user prompts. */
  contentIsArray: boolean;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
}

export interface Turn {
  user: string;
  assistant: string;
}

/**
 * Parse a single JSONL line. Returns null on malformed or unrecognized shape.
 */
export function parseTranscriptLine(line: string): TranscriptEntry | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  const type = typeof o.type === "string" ? o.type : null;
  if (!type) return null;

  const message = o.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return null;

  const role = typeof message.role === "string" ? message.role : type;

  const content = extractContent(message.content);
  if (content === null) return null;

  return {
    type,
    role,
    content,
    contentIsArray: Array.isArray(message.content),
    uuid: typeof o.uuid === "string" ? o.uuid : undefined,
    parentUuid: typeof o.parentUuid === "string" ? o.parentUuid : undefined,
    timestamp: typeof o.timestamp === "string" ? o.timestamp : undefined,
  };
}

function extractContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      if (typeof it.text === "string") parts.push(it.text);
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

/**
 * Read the latest complete user+assistant turn from a transcript jsonl file.
 * Returns null if the file is missing, empty, or contains no complete turn.
 *
 * A single turn may span multiple transcript entries when the assistant
 * response is split by tool-use / tool-result cycles. This function merges
 * all assistant text blocks between the last real user prompt and the end
 * of the file so the full response is captured — not just the first or
 * last fragment.
 */
export async function readLatestTurn(path: string): Promise<Turn | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  // Walk backwards collecting ALL assistant text blocks until we hit a
  // real user prompt (tool_result entries return null from
  // parseTranscriptLine, so they are silently skipped).
  const assistantParts: string[] = [];
  let user: string | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseTranscriptLine(lines[i]);
    if (!entry) continue;
    if (entry.role === "assistant") {
      if (entry.content) assistantParts.unshift(entry.content);
    } else if (entry.role === "user" && !entry.contentIsArray) {
      // Only treat string-content user entries as real prompts.
      // Array-content entries are tool_result / skill output / attachments.
      if (assistantParts.length > 0) {
        user = entry.content;
        break;
      }
    }
  }

  if (user === null || assistantParts.length === 0) return null;
  return { user, assistant: assistantParts.join("\n\n") };
}

/**
 * Read ALL complete user+assistant turns from a transcript. Each turn
 * merges multi-part assistant responses (split by tool cycles) into a
 * single string, same as {@link readLatestTurn}.
 */
export async function readAllTurns(path: string): Promise<Turn[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const turns: Turn[] = [];
  let currentUser: string | null = null;
  let assistantParts: string[] = [];

  for (const line of lines) {
    const entry = parseTranscriptLine(line);
    if (!entry) continue;

    if (entry.role === "user" && !entry.contentIsArray) {
      // Only string-content user entries are real prompts.
      // Array-content entries (tool_result, skill output) are skipped.
      if (currentUser !== null && assistantParts.length > 0) {
        turns.push({ user: currentUser, assistant: assistantParts.join("\n\n") });
      }
      currentUser = entry.content;
      assistantParts = [];
    } else if (entry.role === "assistant" && entry.content) {
      assistantParts.push(entry.content);
    }
  }

  // Flush final turn.
  if (currentUser !== null && assistantParts.length > 0) {
    turns.push({ user: currentUser, assistant: assistantParts.join("\n\n") });
  }

  return turns;
}
