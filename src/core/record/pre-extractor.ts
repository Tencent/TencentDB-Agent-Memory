/**
 * Pre-Extractor: rule-based memory extraction BEFORE the LLM call.
 *
 * Catches obvious patterns that don't need LLM inference, reducing both
 * token cost and hallucination risk. The LLM still handles complex/ambiguous
 * cases, but this layer catches the low-hanging fruit deterministically.
 *
 * Two modes:
 *   1. HIGH-confidence matches → extracted directly (bypass LLM for this item)
 *   2. MEDIUM-confidence matches → passed as hints to guide LLM extraction
 *
 * v1: Focus on the most reliable patterns — explicit persona, instruction,
 *     and date-tagged episodic markers.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { ExtractedMemory } from "./l1-writer.js";

// ============================
// Types
// ============================

export interface PreExtractedMemory {
  content: string;
  type: "persona" | "episodic" | "instruction";
  priority: number;
  source_message_ids: string[];
  /** HIGH = bypass LLM, MEDIUM = pass as hint */
  confidence: "HIGH" | "MEDIUM";
  /** How this was detected (for debugging) */
  rule: string;
}

export interface PreExtractionResult {
  /** Items to add directly without LLM processing */
  direct: PreExtractedMemory[];
  /** Items to pass as hints to the LLM */
  hints: PreExtractedMemory[];
}

// ============================
// Persona patterns
// ============================

interface PersonaRule {
  pattern: RegExp;
  /** Template to generate memory content. $1 = capture group, $TEXT = full match */
  template: string;
  priority: number;
}

const PERSONA_RULES: PersonaRule[] = [
  // Explicit preference statements
  {
    pattern: /我(?:很|非常|比较|特别)?喜欢(.{1,30})/,
    template: "用户喜欢$1",
    priority: 70,
  },
  {
    pattern: /我(?:很|非常|比较|特别)?讨厌(.{1,30})/,
    template: "用户讨厌$1",
    priority: 75,
  },
  {
    pattern: /我习惯(.{1,30})/,
    template: "用户习惯$1",
    priority: 65,
  },
  {
    pattern: /我经常(.{1,30})/,
    template: "用户经常$1",
    priority: 60,
  },
  // Identity / role statements
  {
    pattern: /我是(?:一[个位名])?(.{1,40})/,
    template: "用户是$1",
    priority: 80,
  },
  {
    pattern: /我的(?:职业|工作|岗位)是(.{1,40})/,
    template: "用户的职业是$1",
    priority: 85,
  },
  // Skill / ability statements
  {
    pattern: /我擅长(.{1,30})/,
    template: "用户擅长$1",
    priority: 70,
  },
  {
    pattern: /我会(.{1,30})/,
    template: "用户会$1",
    priority: 55,
  },
  // Value judgments
  {
    pattern: /我认为(.{1,50})/,
    template: "用户认为$1",
    priority: 60,
  },
];

// ============================
// Instruction patterns
// ============================

interface InstructionRule {
  pattern: RegExp;
  template: string;
  priority: number;
}

const INSTRUCTION_RULES: InstructionRule[] = [
  {
    pattern: /以后(?:都|要|请)?(.{1,50})/,
    template: "用户要求 AI 以后$1",
    priority: 90,
  },
  {
    pattern: /从现在开始.{0,5}?(.{1,50})/,
    template: "用户要求 AI 从现在开始$1",
    priority: 90,
  },
  {
    pattern: /记住.{0,5}?(.{1,50})/,
    template: "用户要求 AI 记住$1",
    priority: 85,
  },
  {
    pattern: /每次(?:都|要|请)?(.{1,50})/,
    template: "用户要求 AI 每次$1",
    priority: 75,
  },
  {
    pattern: /(?:用|使用|切换为|换成)(中文|英文|日文|法文)回复/,
    template: "用户要求 AI 使用$1回复",
    priority: 95,
  },
  {
    pattern: /回复(?:时|的时候).{0,5}?(.{1,40})/,
    template: "用户要求 AI 回复时$1",
    priority: 80,
  },
  {
    pattern: /不要.{0,3}?(.{1,40})/,
    template: "用户要求 AI 不要$1",
    priority: 85,
  },
  {
    pattern: /禁止(.{1,40})/,
    template: "用户禁止 AI $1",
    priority: 95,
  },
];

// ============================
// Episodic patterns (date-tagged)
// ============================

const DATE_PATTERN = /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?)/;
const TIME_PATTERN = /(\d{1,2}:\d{2}(?::\d{2})?)/;

// Verbs that signal completed actions worth remembering
const EPISODIC_ACTION_VERBS = [
  "部署", "上线", "发布了", "提交了", "推送了", "合并了",
  "安装", "配置", "搭建",
  "完成", "解决", "修复", "优化",
  "开会", "讨论了", "决定了", "确定了",
  "购买了", "下载了", "注册了",
  "deployed", "released", "merged", "installed", "configured",
  "fixed", "resolved", "completed",
];

// ============================
// Main extraction function
// ============================

/**
 * Pre-extract memories using deterministic rules.
 * Runs BEFORE the LLM extraction call.
 *
 * @param messages - Messages to scan (already filtered by shouldExtractL1)
 * @returns Memories with confidence levels
 */
export function preExtractMemories(
  messages: ConversationMessage[],
): PreExtractionResult {
  const direct: PreExtractedMemory[] = [];
  const hints: PreExtractedMemory[] = [];

  for (const msg of messages) {
    const text = msg.content;

    // ── Persona detection ──
    for (const rule of PERSONA_RULES) {
      const match = text.match(rule.pattern);
      if (match && match[1]) {
        const captured = match[1].trim();
        // Reject if captured text is too short or just punctuation
        if (captured.length < 2 || /^[，。、！？,.!?\s]+$/.test(captured)) continue;

        const content = rule.template.replace("$1", captured);
        const isHighConfidence =
          rule.priority >= 80 || captured.length > 5;

        const entry: PreExtractedMemory = {
          content,
          type: "persona",
          priority: rule.priority,
          source_message_ids: [msg.id],
          confidence: isHighConfidence ? "HIGH" : "MEDIUM",
          rule: `persona:${rule.pattern.source.slice(0, 30)}`,
        };

        if (isHighConfidence) {
          direct.push(entry);
        } else {
          hints.push(entry);
        }
        break; // One persona match per message
      }
    }

    // ── Instruction detection ──
    for (const rule of INSTRUCTION_RULES) {
      const match = text.match(rule.pattern);
      if (match && match[1]) {
        const captured = match[1].trim();
        if (captured.length < 2 || /^[，。、！？,.!?\s]+$/.test(captured)) continue;

        const content = rule.template.replace("$1", captured);
        // Instructions are always HIGH confidence — they're explicit directives
        const entry: PreExtractedMemory = {
          content,
          type: "instruction",
          priority: rule.priority,
          source_message_ids: [msg.id],
          confidence: "HIGH",
          rule: `instruction:${rule.pattern.source.slice(0, 40)}`,
        };
        direct.push(entry);
        break;
      }
    }

    // ── Episodic detection (weaker; only flag with date) ──
    const hasDate = DATE_PATTERN.test(text);
    if (hasDate) {
      const hasActionVerb = EPISODIC_ACTION_VERBS.some((verb) => text.includes(verb));
      if (hasActionVerb) {
        // Strong signal: date + action verb → likely episodic
        const dateMatch = text.match(DATE_PATTERN);
        const timeMatch = text.match(TIME_PATTERN);
        const dateStr = dateMatch ? dateMatch[1] : "某时间";
        const timeStr = timeMatch ? ` ${timeMatch[1]}` : "";

        hints.push({
          content: `用户在 ${dateStr}${timeStr} 进行了一次活动（涉及：${text.slice(0, 80)}）`,
          type: "episodic",
          priority: 60,
          source_message_ids: [msg.id],
          confidence: "MEDIUM",
          rule: "episodic:date+verb",
        });
      }
    }
  }

  return { direct, hints };
}

/**
 * Merge rule-extracted direct memories with LLM-extracted memories.
 * Rule-extracted HIGH-confidence items always win; if LLM also extracted
 * the same content, the rule version takes precedence.
 */
export function mergeExtractedMemories(
  llmMemories: ExtractedMemory[],
  preResult: PreExtractionResult,
): ExtractedMemory[] {
  // Start with LLM memories
  const merged: ExtractedMemory[] = [...llmMemories];

  // Add direct rule-extracted items (skip duplicates by content similarity)
  for (const pre of preResult.direct) {
    const isDuplicate = merged.some(
      (m) => contentSimilarity(m.content, pre.content) > 0.7,
    );
    if (!isDuplicate) {
      merged.push({
        content: pre.content,
        type: pre.type,
        priority: pre.priority,
        source_message_ids: pre.source_message_ids,
        metadata: {},
        scene_name: "（规则预提取）",
      });
    }
  }

  return merged;
}

/**
 * Quick Jaccard-like content similarity check to avoid duplicates.
 * Returns a value in [0, 1].
 */
function contentSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/[\s，。、！？,.!?]+/).filter(Boolean));
  const wordsB = new Set(b.split(/[\s，。、！？,.!?]+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / Math.max(wordsA.size, wordsB.size);
}
