/**
 * L1 Memory Extractor: extracts structured memories from L0 conversation messages
 * using a single LLM call with JSON-mode structured output.
 *
 * v3: Aligned with Kenty's prompt — scene segmentation + memory extraction in one call,
 * followed by batch conflict detection.
 *
 * Pipeline:
 * 1. Read recent messages from L0 (split into background + new)
 * 2. Call LLM to extract scene-segmented memories
 * 3. Batch conflict detection against existing records
 * 4. Write to L1 JSONL files
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";
import { EXTRACT_MEMORIES_SYSTEM_PROMPT, formatExtractionPrompt } from "../prompts/l1-extraction.js";
import { batchDedup } from "./l1-dedup.js";
import { writeMemory, generateMemoryId } from "./l1-writer.js";
import type { ExtractedMemory, MemoryRecord, MemoryType, DedupDecision } from "./l1-writer.js";
import { preExtractMemories, mergeExtractedMemories } from "./pre-extractor.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { sanitizeJsonForParse, shouldExtractL1 } from "../../utils/sanitize.js";
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import { report } from "../report/reporter.js";
import type { LLMRunner } from "../types.js";

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const TAG = "[memory-tdai][l1-extractor]";

// ============================
// Types
// ============================

/** A scene segment with its extracted memories (LLM output) */
interface SceneSegment {
  scene_name: string;
  message_ids: string[];
  memories: Array<{
    content: string;
    type: string;
    priority: number;
    source_message_ids: string[];
    metadata: Record<string, unknown>;
  }>;
}

export interface L1ExtractionResult {
  /** Whether extraction succeeded */
  success: boolean;
  /** Number of memories extracted */
  extractedCount: number;
  /** Number of memories actually stored (after dedup) */
  storedCount: number;
  /** The memory records that were stored */
  records: MemoryRecord[];
  /** Scene names detected during extraction */
  sceneNames: string[];
  /** Last scene name (for continuity in next extraction) */
  lastSceneName?: string;
}

// ============================
// Core function
// ============================

/**
 * Run the full L1 extraction pipeline on conversation messages.
 *
 * @param messages - Filtered conversation messages (from L0 or directly from hook)
 * @param sessionKey - The session key
 * @param baseDir - Base data directory (~/.openclaw/memory-tdai/)
 * @param config - OpenClaw config (for LLM access)
 * @param options - Extraction options
 * @param logger - Optional logger
 */
export async function extractL1Memories(params: {
  messages: ConversationMessage[];
  sessionKey: string;
  sessionId?: string;
  baseDir: string;
  config: unknown;
  options?: {
    /** Max new messages to send in one extraction call */
    maxMessagesPerExtraction?: number;
    /** Max background messages for context */
    maxBackgroundMessages?: number;
    /** Enable conflict detection */
    enableDedup?: boolean;
    /** Max memories extracted per call */
    maxMemoriesPerSession?: number;
    /** LLM model override */
    model?: string;
    /** Previous scene name for continuity */
    previousSceneName?: string;
    /** Vector store for cosine similarity candidate recall */
    vectorStore?: IMemoryStore;
    /** Embedding service for computing query vectors */
    embeddingService?: EmbeddingService;
    /** Top-K candidates for conflict recall (default: 5) */
    conflictRecallTopK?: number;
    /** Override embedding timeout for capture-path calls (milliseconds) */
    embeddingTimeoutMs?: number;
    /**
     * Host-neutral LLM runner. When provided, used instead of creating
     * a CleanContextRunner (decouples from OpenClaw runtime).
     */
    llmRunner?: LLMRunner;
  };
  logger?: Logger;
  /** Plugin instance ID for metric reporting (optional — metrics skipped if absent) */
  instanceId?: string;
}): Promise<L1ExtractionResult> {
  const { messages, sessionKey, sessionId, baseDir, config, logger, instanceId: metricInstanceId } = params;
  const options = params.options ?? {};
  const maxNewMessages = options.maxMessagesPerExtraction ?? 10;
  const maxBgMessages = options.maxBackgroundMessages ?? 5;
  const enableDedup = options.enableDedup ?? true;
  const maxMemoriesPerSession = options.maxMemoriesPerSession ?? 10;

  if (messages.length === 0) {
    logger?.debug?.(`${TAG} No messages to extract from`);
    return { success: true, extractedCount: 0, storedCount: 0, records: [], sceneNames: [] };
  }

  const l1StartMs = Date.now();

  // Quality gate: filter messages through L1 extraction rules (length, symbols,
  // prompt injection, etc.) before sending to the LLM. L0 deliberately captures
  // everything; the strict filtering happens here at L1 stage.
  const qualifiedMessages = messages.filter((m) => shouldExtractL1(m.content));
  if (qualifiedMessages.length < messages.length) {
    logger?.debug?.(
      `${TAG} L1 quality filter: ${messages.length} → ${qualifiedMessages.length} messages ` +
      `(${messages.length - qualifiedMessages.length} filtered out)`,
    );
  }

  if (qualifiedMessages.length === 0) {
    logger?.debug?.(`${TAG} All messages filtered out by L1 quality gate`);
    return { success: true, extractedCount: 0, storedCount: 0, records: [], sceneNames: [] };
  }

  // ── Step 0: Rule-based pre-extraction (v3.1) ──
  // Catch obvious persona/instruction patterns BEFORE the LLM call.
  // This reduces token cost for clear patterns and provides hints to the LLM.
  const preResult = preExtractMemories(qualifiedMessages);
  if (preResult.direct.length > 0) {
    logger?.debug?.(
      `${TAG} Pre-extracted ${preResult.direct.length} HIGH-confidence items directly (bypass LLM)`);
  }
  if (preResult.hints.length > 0) {
    logger?.debug?.(
      `${TAG} Pre-extracted ${preResult.hints.length} MEDIUM-confidence hints for LLM guidance`);
  }

  // Split messages into background (older) + new (recent)
  const newMessages = qualifiedMessages.slice(-maxNewMessages);
  const bgEndIdx = qualifiedMessages.length - newMessages.length;
  const backgroundMessages = bgEndIdx > 0
    ? qualifiedMessages.slice(Math.max(0, bgEndIdx - maxBgMessages), bgEndIdx)
    : [];

  logger?.debug?.(`${TAG} Extracting from ${newMessages.length} new messages (+ ${backgroundMessages.length} background) [${qualifiedMessages.length} qualified from ${messages.length} input]`);

  // Step 1: LLM extraction (scene segmentation + memory extraction)
  let scenes: SceneSegment[];
  try {
    scenes = await callLlmExtraction({
      newMessages,
      backgroundMessages,
      previousSceneName: options.previousSceneName,
      config,
      logger,
      model: options.model,
      llmRunner: options.llmRunner,
    });
    logger?.debug?.(`${TAG} LLM detected ${scenes.length} scene(s)`);
  } catch (err) {
    logger?.error(`${TAG} LLM extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, extractedCount: 0, storedCount: 0, records: [], sceneNames: [] };
  }

  // Flatten all memories across scenes
  const allExtracted: ExtractedMemory[] = [];
  const sceneNames: string[] = [];

  for (const scene of scenes) {
    sceneNames.push(scene.scene_name);
    for (const mem of scene.memories) {
      const memType = normalizeType(mem.type);
      if (!memType) {
        logger?.warn?.(`${TAG} Skipping memory with invalid type "${mem.type}"`);
        continue;
      }
      allExtracted.push({
        content: mem.content,
        type: memType,
        priority: typeof mem.priority === "number" ? mem.priority : 50,
        source_message_ids: Array.isArray(mem.source_message_ids) ? mem.source_message_ids : [],
        metadata: mem.metadata ?? {},
        scene_name: scene.scene_name,
      });
    }
  }

  logger?.debug?.(`${TAG} Total extracted memories: ${allExtracted.length} across ${scenes.length} scene(s)`);

  // ── Merge rule-extracted direct items into LLM results ──
  if (preResult.direct.length > 0) {
    const beforeMerge = allExtracted.length;
    const merged = mergeExtractedMemories(allExtracted, preResult);
    const added = merged.length - beforeMerge;
    if (added > 0) {
      logger?.debug?.(
        `${TAG} Merged ${added} pre-extracted items into LLM results (total: ${merged.length})`);
    }
    allExtracted.length = 0;
    allExtracted.push(...merged);
  }

  // ── Confidence check: filter low-quality LLM extractions ──
  const confidenceFiltered = allExtracted
    .filter((m) => passesConfidenceCheck(m, messages, logger));
  if (confidenceFiltered.length < allExtracted.length) {
    logger?.debug?.(
      `${TAG} Confidence filter: ${allExtracted.length} → ${confidenceFiltered.length} memories ` +
      `(${allExtracted.length - confidenceFiltered.length} rejected)`);
    allExtracted.length = 0;
    allExtracted.push(...confidenceFiltered);
  }

  if (allExtracted.length === 0) {
    return {
      success: true,
      extractedCount: 0,
      storedCount: 0,
      records: [],
      sceneNames,
      lastSceneName: sceneNames[sceneNames.length - 1],
    };
  }

  // Limit per session
  let extracted = allExtracted;
  if (extracted.length > maxMemoriesPerSession) {
    logger?.debug?.(`${TAG} Limiting from ${extracted.length} to ${maxMemoriesPerSession} memories per session`);
    extracted = extracted.slice(0, maxMemoriesPerSession);
  }

  // Assign temporary IDs to extracted memories (needed for batch dedup)
  const memoriesWithIds = extracted.map((m) => ({
    ...m,
    record_id: generateMemoryId(),
  }));

  // Step 2: Batch Conflict Detection + Write
  let storedRecords: MemoryRecord[];

  if (enableDedup) {
    try {
      const decisions = await batchDedup({
        memories: memoriesWithIds,
        config,
        logger,
        model: options.model,
        vectorStore: options.vectorStore,
        embeddingService: options.embeddingService,
        conflictRecallTopK: options.conflictRecallTopK,
        embeddingTimeoutMs: options.embeddingTimeoutMs,
        llmRunner: options.llmRunner,
      });

      storedRecords = await applyDecisions({
        memoriesWithIds,
        decisions,
        baseDir,
        sessionKey,
        sessionId,
        logger,
        vectorStore: options.vectorStore,
        embeddingService: options.embeddingService,
      });
    } catch (err) {
      logger?.warn?.(`${TAG} Batch dedup failed, storing all as new: ${err instanceof Error ? err.message : String(err)}`);
      storedRecords = await storeAllDirectly(memoriesWithIds, baseDir, sessionKey, sessionId, logger, options.vectorStore, options.embeddingService);
    }
  } else {
    storedRecords = await storeAllDirectly(memoriesWithIds, baseDir, sessionKey, sessionId, logger, options.vectorStore, options.embeddingService);
  }

  logger?.info(`${TAG} Extraction complete: extracted=${extracted.length}, stored=${storedRecords.length}`);

  // ── l1_extraction metric ──
  if (metricInstanceId && logger) {
    // Build type distribution of stored memories
    const memoriesByType: Record<string, number> = {};
    for (const r of storedRecords) {
      memoriesByType[r.type] = (memoriesByType[r.type] ?? 0) + 1;
    }
    report("l1_extraction", {
      sessionKey,
      inputMessageCount: messages.length,
      memoriesExtracted: extracted.length,
      memoriesStored: storedRecords.length,
      memoriesStoredContent: storedRecords.map((r) => ({
        content: r.content,
        type: r.type,
        scene: r.scene_name ?? null,
      })),
      memoriesByType,
      totalDurationMs: Date.now() - l1StartMs,
      success: true,
      error: null,
    });
  }

  return {
    success: true,
    extractedCount: extracted.length,
    storedCount: storedRecords.length,
    records: storedRecords,
    sceneNames,
    lastSceneName: sceneNames[sceneNames.length - 1],
  };
}

// ============================
// LLM call
// ============================

/**
 * Call LLM to extract scene-segmented memories from conversation messages.
 */
async function callLlmExtraction(params: {
  newMessages: ConversationMessage[];
  backgroundMessages: ConversationMessage[];
  previousSceneName?: string;
  config: unknown;
  logger?: Logger;
  model?: string;
  /** Host-neutral LLM runner — when provided, used instead of CleanContextRunner. */
  llmRunner?: LLMRunner;
}): Promise<SceneSegment[]> {
  const { newMessages, backgroundMessages, previousSceneName, config, logger, model, llmRunner } = params;

  const userPrompt = formatExtractionPrompt({
    newMessages,
    backgroundMessages,
    previousSceneName,
  });

  // [l1-debug] ENTRY — what are we about to ask the LLM to extract?
  logger?.debug?.(
    `${TAG} [l1-debug] ENTRY taskId=l1-extraction, newMsgs=${newMessages.length}, bgMsgs=${backgroundMessages.length}, userPromptLen=${userPrompt.length}, sysPromptLen=${EXTRACT_MEMORIES_SYSTEM_PROMPT.length}, model=${model ?? "(default)"}, previousSceneName=${previousSceneName ? JSON.stringify(previousSceneName) : "(none)"}, runnerKind=${llmRunner ? "llmRunner" : "CleanContextRunner"}`,
  );

  const runLlm = async (prompt: string, systemPrompt: string, taskId: string): Promise<string> => {
    if (llmRunner) {
      return llmRunner.run({ prompt, systemPrompt, taskId, timeoutMs: 180_000 });
    }
    const runner = new CleanContextRunner({
      config,
      modelRef: model,
      enableTools: false,
      logger,
    });
    return runner.run({ prompt, systemPrompt, taskId, timeoutMs: 180_000 });
  };

  let result = await runLlm(userPrompt, EXTRACT_MEMORIES_SYSTEM_PROMPT, "l1-extraction");

  const { scenes, parseError } = parseExtractionResultWithError(result, logger);

  // ── Self-correction retry: if JSON parsing failed, retry once with error feedback ──
  if (parseError && scenes.length === 0) {
    logger?.warn?.(
      `${TAG} First extraction JSON parse failed: ${parseError.slice(0, 200)}. Retrying with correction hint...`);

    try {
      const correctionPrompt = `${userPrompt}\n\n【⚠ 格式错误】你上一次的输出无法解析为有效 JSON。错误信息：${parseError}\n请严格按照要求的 JSON 数组格式重新输出，不要添加任何解释或 Markdown 代码块标记。`;
      result = await runLlm(correctionPrompt, EXTRACT_MEMORIES_SYSTEM_PROMPT, "l1-extraction-retry");
      const retryResult = parseExtractionResultWithError(result, logger);
      if (retryResult.scenes.length > 0) {
        logger?.info?.(`${TAG} Self-correction retry succeeded: ${retryResult.scenes.length} scene(s) extracted`);
        return retryResult.scenes;
      }
      logger?.warn?.(`${TAG} Self-correction retry also failed: ${retryResult.parseError?.slice(0, 200)}`);
    } catch (err) {
      logger?.warn?.(`${TAG} Self-correction retry threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return scenes;
}

/**
 * Parse the LLM's JSON response into SceneSegment array.
 * Expected format: [{scene_name, message_ids, memories: [...]}]
 */
function parseExtractionResult(raw: string, logger?: Logger): SceneSegment[] {
  return parseExtractionResultWithError(raw, logger).scenes;
}

/**
 * Parse the LLM's JSON response, returning both scenes and parse error (if any).
 * This allows the caller to use the error for self-correction retry.
 */
function parseExtractionResultWithError(
  raw: string,
  logger?: Logger,
): { scenes: SceneSegment[]; parseError?: string } {
  try {
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      const rawPreview = raw.slice(0, 2048);
      logger?.warn?.(`${TAG} No JSON array found in extraction response`);
      logger?.warn?.(
        `${TAG} [l1-debug] NO_JSON taskId=l1-extraction, rawLen=${raw.length}, cleanedLen=${cleaned.length}, rawFull=${JSON.stringify(rawPreview)}${raw.length > 2048 ? `…(+${raw.length - 2048})` : ""}`,
      );
      return { scenes: [], parseError: "输出中未找到 JSON 数组" };
    }

    const sanitized = sanitizeJsonForParse(arrayMatch[0]);
    const parsed = JSON.parse(sanitized) as unknown[];

    if (!Array.isArray(parsed)) {
      logger?.warn?.(`${TAG} Extraction response is not an array`);
      return { scenes: [], parseError: "输出不是 JSON 数组" };
    }

    const scenes: SceneSegment[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const s = item as Record<string, unknown>;

      scenes.push({
        scene_name: typeof s.scene_name === "string" ? s.scene_name : "未知情境",
        message_ids: Array.isArray(s.message_ids) ? s.message_ids.map(String) : [],
        memories: Array.isArray(s.memories)
          ? (s.memories as Array<Record<string, unknown>>)
              .filter((m) => m && typeof m === "object" && typeof m.content === "string" && (m.content as string).length > 0)
              .map((m) => ({
                content: String(m.content),
                type: String(m.type ?? "episodic"),
                priority: typeof m.priority === "number" ? m.priority : 50,
                source_message_ids: Array.isArray(m.source_message_ids) ? m.source_message_ids.map(String) : [],
                metadata: (m.metadata && typeof m.metadata === "object" ? m.metadata : {}) as Record<string, unknown>,
              }))
          : [],
      });
    }

    return { scenes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`${TAG} Failed to parse extraction result: ${msg}`);
    return { scenes: [], parseError: `JSON 解析失败: ${msg}` };
  }
}

// ============================
// Write helpers
// ============================

/**
 * Apply batch dedup decisions — write memories according to their decisions.
 */
async function applyDecisions(params: {
  memoriesWithIds: Array<ExtractedMemory & { record_id: string }>;
  decisions: DedupDecision[];
  baseDir: string;
  sessionKey: string;
  sessionId?: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
}): Promise<MemoryRecord[]> {
  const { memoriesWithIds, decisions, baseDir, sessionKey, sessionId, logger, vectorStore, embeddingService } = params;
  const storedRecords: MemoryRecord[] = [];

  // Build a map from record_id → decision
  const decisionMap = new Map<string, DedupDecision>();
  for (const d of decisions) {
    decisionMap.set(d.record_id, d);
  }

  for (const memoryWithId of memoriesWithIds) {
    const decision = decisionMap.get(memoryWithId.record_id) ?? {
      record_id: memoryWithId.record_id,
      action: "store" as const,
      target_ids: [],
    };

    try {
      const record = await writeMemory({
        memory: memoryWithId,
        decision,
        baseDir,
        sessionKey,
        sessionId,
        logger,
        vectorStore,
        embeddingService,
      });

      if (record) {
        storedRecords.push(record);
      }
    } catch (err) {
      logger?.warn?.(
        `${TAG} Write failed for memory "${memoryWithId.content.slice(0, 50)}...": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return storedRecords;
}

/**
 * Store all memories directly (no dedup).
 */
async function storeAllDirectly(
  memoriesWithIds: Array<ExtractedMemory & { record_id: string }>,
  baseDir: string,
  sessionKey: string,
  sessionId: string | undefined,
  logger?: Logger,
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
): Promise<MemoryRecord[]> {
  const storedRecords: MemoryRecord[] = [];

  for (const memoryWithId of memoriesWithIds) {
    try {
      const record = await writeMemory({
        memory: memoryWithId,
        decision: {
          record_id: memoryWithId.record_id,
          action: "store",
          target_ids: [],
        },
        baseDir,
        sessionKey,
        sessionId,
        logger,
        vectorStore,
        embeddingService,
      });
      if (record) {
        storedRecords.push(record);
      }
    } catch (err) {
      logger?.warn?.(
        `${TAG} Write failed for memory "${memoryWithId.content.slice(0, 50)}...": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return storedRecords;
}

// ============================
// Confidence check
// ============================

/**
 * Validate an LLM-extracted memory against basic quality heuristics.
 * Returns false if the memory appears to be hallucinated or too low-quality.
 */
function passesConfidenceCheck(
  mem: ExtractedMemory,
  allMessages: ConversationMessage[],
  logger?: Logger,
): boolean {
  // Check 1: Minimal content
  const isCJK = /[\u4e00-\u9fff]/.test(mem.content);
  if (isCJK && mem.content.length < 4) {
    logger?.debug?.(`${TAG} [confidence] REJECT too-short-CJK: "${mem.content.slice(0, 40)}"`);
    return false;
  }
  if (!isCJK && mem.content.length < 15) {
    logger?.debug?.(`${TAG} [confidence] REJECT too-short: "${mem.content.slice(0, 40)}"`);
    return false;
  }

  // Check 2: Source traceability
  const memWords = extractSignificantWords(mem.content);
  if (memWords.size === 0) {
    logger?.debug?.(`${TAG} [confidence] REJECT no-meaningful-words: "${mem.content.slice(0, 40)}"`);
    return false;
  }

  const sourceMsgs = allMessages.filter((m) =>
    mem.source_message_ids.includes(m.id),
  );

  if (sourceMsgs.length > 0) {
    let matchedWords = 0;
    for (const word of memWords) {
      for (const src of sourceMsgs) {
        if (src.content.includes(word)) { matchedWords++; break; }
      }
    }
    const matchRatio = memWords.size > 0 ? matchedWords / memWords.size : 0;
    if (matchRatio < 0.3) {
      logger?.debug?.(
        `${TAG} [confidence] REJECT low-traceability (${(matchRatio * 100).toFixed(0)}%): "${mem.content.slice(0, 60)}"`);
      return false;
    }
  }

  // Check 3: Type consistency
  if (mem.type === "persona") {
    if (!/[用我]户|我/.test(mem.content)) {
      logger?.debug?.(`${TAG} [confidence] REJECT persona-no-user-ref: "${mem.content.slice(0, 40)}"`);
      return false;
    }
  }

  if (mem.type === "instruction") {
    if (!/AI|回复|回答|使用|输出|禁止|必须|要求/.test(mem.content)) {
      logger?.debug?.(`${TAG} [confidence] REJECT instruction-no-directive: "${mem.content.slice(0, 40)}"`);
      return false;
    }
  }

  if (mem.type === "episodic") {
    if (/^用户询问了|^用户说了|^用户问了|^AI回答/.test(mem.content) && mem.content.length < 30) {
      logger?.debug?.(`${TAG} [confidence] REJECT trivial-episodic: "${mem.content.slice(0, 40)}"`);
      return false;
    }
  }

  return true;
}

/**
 * Extract significant words from text for source traceability.
 * CJK: 2+ character sequences as overlapping bigrams. Non-CJK: 4+ letter words.
 */
function extractSignificantWords(text: string): Set<string> {
  const words = new Set<string>();
  const cjkSeq = text.match(/[\u4e00-\u9fff]{2,}/g);
  if (cjkSeq) {
    for (const seq of cjkSeq) {
      for (let i = 0; i <= seq.length - 2; i++) {
        words.add(seq.slice(i, i + 2));
      }
    }
  }
  const alphaWords = text.match(/[a-zA-Z]{4,}/g);
  if (alphaWords) {
    for (const w of alphaWords) words.add(w.toLowerCase());
  }
  return words;
}

// ============================
// Helpers
// ============================

const VALID_TYPES: MemoryType[] = ["persona", "episodic", "instruction"];

function normalizeType(raw: string): MemoryType | null {
  const lower = raw.toLowerCase().trim();
  if (VALID_TYPES.includes(lower as MemoryType)) {
    return lower as MemoryType;
  }
  // Handle legacy type names
  if (lower === "episode") return "episodic";
  if (lower === "instruct") return "instruction";
  if (lower === "preference") return "persona"; // fold preference into persona
  return null;
}
