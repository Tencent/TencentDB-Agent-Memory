/**
 * Langfuse 过滤型 SpanProcessor（门面层）。
 *
 * 只转发 LLM 相关的 span（ai.* / gen_ai.* 前缀）到 Langfuse OTLP 端点，
 * 其他工程调用 span 被丢弃，避免流量过大。
 *
 * 设计原则：
 * - 不影响现有 span 生命周期
 * - exporter 失败时静默忽略
 * - 配置缺失时 graceful degradation
 *
 * 公开 API 签名保持不变，调用方无需修改。
 * 具体实现由 ILLMTraceBackend 提供。
 */

import { getObservabilityBackend } from "./factory.js";
import type { ISpanProcessor } from "./types.js";

// ============================
// 配置类型（保持向后兼容导出）
// ============================

export interface LangfuseConfigEnabled {
  enabled: true;
  host: string;
  publicKey: string;
  secretKey: string;
}

export interface LangfuseConfigDisabled {
  enabled: false;
}

export type LangfuseConfig = LangfuseConfigEnabled | LangfuseConfigDisabled;

// ============================
// 配置解析（保持向后兼容导出）
// ============================

/**
 * 从环境变量解析 Langfuse 配置。
 *
 * 环境变量：
 * - LANGFUSE_ENABLED    : "true" 启用（默认 "false"）
 * - LANGFUSE_HOST       : Langfuse 实例地址（如 http://langfuse.example.local:3000）
 * - LANGFUSE_PUBLIC_KEY : 公钥
 * - LANGFUSE_SECRET_KEY : 私钥
 *
 * 任何必要配置缺失时返回 { enabled: false }。
 */
export function parseLangfuseConfig(): LangfuseConfig {
  const enabled = process.env.LANGFUSE_ENABLED === "true";
  if (!enabled) {
    return { enabled: false };
  }

  const host = process.env.LANGFUSE_HOST;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  // 任何必要配置缺失时 graceful degradation
  if (!host || !publicKey || !secretKey) {
    return { enabled: false };
  }

  return { enabled: true, host, publicKey, secretKey };
}

// ============================
// Span 过滤逻辑（保持向后兼容导出）
// ============================

/**
 * 判断 span 是否为 LLM 相关。
 *
 * 放行规则（Vercel AI SDK 的 experimental_telemetry 产生的 span）：
 * - `ai.*`     : ai.generateText, ai.streamText, ai.toolCall, ai.generateObject 等
 * - `gen_ai.*` : gen_ai.chat, gen_ai.embeddings 等（OpenTelemetry GenAI 语义约定）
 *
 * 其他所有 span（gateway.*, core.*, queue.*, http.* 等）被过滤。
 */
export function isLLMRelatedSpan(spanName: string): boolean {
  if (!spanName) return false;
  return spanName.startsWith("ai.") || spanName.startsWith("gen_ai.");
}

// ============================
// LangfuseFilteringProcessor（门面层）
// ============================

/**
 * 创建 Langfuse SpanProcessor 实例。
 * 通过 ILLMTraceBackend 接口获取实际的 processor。
 *
 * @returns SpanProcessor 实例，或 null（如果 Langfuse 未启用）
 */
export function createLangfuseSpanProcessor(): ISpanProcessor | null {
  try {
    return getObservabilityBackend().llmTrace.createSpanProcessor();
  } catch {
    return null;
  }
}

/**
 * 兼容层：LangfuseFilteringProcessor 类。
 * 保持向后兼容，内部委托给 ILLMTraceBackend。
 *
 * 当 ILLMTraceBackend 返回有效 processor 时，委托给它处理；
 * 否则回退到使用传入的 exporter 做过滤 + export（直接转发 LLM span）。
 */
export class LangfuseFilteringProcessor implements ISpanProcessor {
  /** 来自 ILLMTraceBackend 的 processor（仅在无 exporter 时使用） */
  private _processor: ISpanProcessor | null;
  /** 由 otel-sdk-init.ts 传入的真正 exporter（优先级最高） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _exporter: any;

  constructor(exporter?: unknown) {
    if (exporter) {
      // 当传入了 exporter 时，优先使用 exporter 做实际 export。
      // otel-sdk-init.ts 已经创建了指向 Langfuse OTLP 端点的 HttpTraceExporter，
      // 这里直接使用它，不再委托给 ILLMTraceBackend（其 processor 可能是空壳）。
      this._exporter = exporter;
      this._processor = null;
    } else {
      // 无 exporter 时，尝试从 ILLMTraceBackend 获取 processor
      this._processor = getObservabilityBackend().llmTrace.createSpanProcessor();
      this._exporter = null;
    }
  }

  onStart(span: unknown, parentContext: unknown): void {
    this._processor?.onStart(span, parentContext);
  }

  onEnd(span: unknown): void {
    try {
      const s = span as { name?: string };
      // 统一过滤：只转发 LLM 相关 span
      if (!s.name || !isLLMRelatedSpan(s.name)) {
        return;
      }

      if (this._exporter) {
        // 使用真正的 exporter 发送到 Langfuse OTLP 端点
        this._exporter.export([span], () => {});
      } else if (this._processor) {
        // 委托给 ILLMTraceBackend 的 processor
        this._processor.onEnd(span);
      }
    } catch {
      // 静默失败，不影响其他 SpanProcessor
    }
  }

  async forceFlush(): Promise<void> {
    if (this._exporter?.forceFlush) {
      await this._exporter.forceFlush();
    } else if (this._processor) {
      await this._processor.forceFlush();
    }
  }

  async shutdown(): Promise<void> {
    if (this._exporter?.shutdown) {
      await this._exporter.shutdown();
    }
    if (this._processor) {
      await this._processor.shutdown();
    }
  }
}
