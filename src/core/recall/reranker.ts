import type { RecallRerankConfig } from "../../config.js";

const TAG = "[memory-tdai] [recall-rerank]";
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_CANDIDATE_MULTIPLIER = 3;
const MAX_CANDIDATE_MULTIPLIER = 10;

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface RerankCandidatesOptions<T> {
  query: string;
  candidates: T[];
  topN: number;
  config?: RecallRerankConfig;
  getDocumentText: (candidate: T) => string;
  logger?: Logger;
}

interface RemoteRerankResult {
  index: number;
  score: number;
}

export function isRerankConfigured(config: RecallRerankConfig | undefined): boolean {
  return !!(
    config?.enabled &&
    config.baseUrl?.trim() &&
    config.apiKey?.trim() &&
    config.model?.trim()
  );
}

export function getRerankCandidateLimit(
  maxResults: number | undefined,
  config: RecallRerankConfig | undefined,
): number {
  const topN = normalizePositiveInt(maxResults, DEFAULT_MAX_RESULTS);
  if (!isRerankConfigured(config)) return topN;
  return topN * normalizeCandidateMultiplier(config?.candidateMultiplier);
}

export async function rerankTextCandidates(options: {
  query: string;
  documents: string[];
  topN: number;
  config?: RecallRerankConfig;
  logger?: Logger;
}): Promise<string[]> {
  return rerankCandidates({
    query: options.query,
    candidates: options.documents,
    topN: options.topN,
    config: options.config,
    getDocumentText: (document) => document,
    logger: options.logger,
  });
}

export async function rerankCandidates<T>(options: RerankCandidatesOptions<T>): Promise<T[]> {
  const topN = normalizePositiveInt(options.topN, DEFAULT_MAX_RESULTS);
  const fallback = options.candidates.slice(0, topN);

  if (options.candidates.length <= 1) return fallback;
  if (!isRerankConfigured(options.config)) return fallback;

  const config = options.config;
  const documents = options.candidates.map(options.getDocumentText);
  const requestTopN = Math.min(topN, documents.length);

  try {
    const results = await callRemoteRerank({
      query: options.query,
      documents,
      topN: requestTopN,
      config,
    });

    if (results.length === 0) return fallback;

    const selected: T[] = [];
    const seen = new Set<number>();

    for (const result of results) {
      if (result.index < 0 || result.index >= options.candidates.length) continue;
      if (seen.has(result.index)) continue;
      selected.push(options.candidates[result.index]);
      seen.add(result.index);
      if (selected.length >= topN) break;
    }

    for (let index = 0; index < options.candidates.length && selected.length < topN; index++) {
      if (seen.has(index)) continue;
      selected.push(options.candidates[index]);
    }

    options.logger?.debug?.(
      `${TAG} Reranked ${options.candidates.length} candidates to top ${selected.length}`,
    );
    return selected;
  } catch (err) {
    options.logger?.warn?.(
      `${TAG} Remote rerank failed; using original recall order: ${err instanceof Error ? err.message : String(err)}`,
    );
    return fallback;
  }
}

async function callRemoteRerank(params: {
  query: string;
  documents: string[];
  topN: number;
  config: RecallRerankConfig;
}): Promise<RemoteRerankResult[]> {
  const timeoutMs = normalizePositiveInt(params.config.timeoutMs, 3000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(buildRerankUrl(params.config.baseUrl!), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.config.apiKey!}`,
      },
      body: JSON.stringify({
        model: params.config.model,
        query: params.query,
        documents: params.documents,
        top_n: params.topN,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }

    const payload = await response.json() as unknown;
    return parseRemoteRerankResults(payload);
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseRemoteRerankResults(payload: unknown): RemoteRerankResult[] {
  const obj = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const rawResults = Array.isArray(obj.results)
    ? obj.results
    : Array.isArray(obj.data)
      ? obj.data
      : [];

  return rawResults
    .map((item): RemoteRerankResult | undefined => {
      if (!item || typeof item !== "object") return undefined;
      const record = item as Record<string, unknown>;
      const index = typeof record.index === "number" ? record.index : Number.NaN;
      const scoreValue = typeof record.relevance_score === "number"
        ? record.relevance_score
        : typeof record.score === "number"
          ? record.score
          : Number.NaN;
      if (!Number.isInteger(index) || !Number.isFinite(scoreValue)) return undefined;
      return { index, score: scoreValue };
    })
    .filter((item): item is RemoteRerankResult => !!item)
    .sort((a, b) => b.score - a.score);
}

function buildRerankUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/rerank") ? trimmed : `${trimmed}/rerank`;
}

function normalizeCandidateMultiplier(value: number | undefined): number {
  const normalized = normalizePositiveInt(value, DEFAULT_CANDIDATE_MULTIPLIER);
  return Math.min(Math.max(normalized, 1), MAX_CANDIDATE_MULTIPLIER);
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
