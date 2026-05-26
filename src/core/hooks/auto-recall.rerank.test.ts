import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../../config.js";
import type { IMemoryStore, L1FtsResult } from "../store/types.js";
import { performAutoRecall } from "./auto-recall.js";

describe("performAutoRecall rerank", () => {
  let dataDir: string | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  it("reranks over-retrieved L1 candidates before injecting top results", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "memory-tdai-rerank-"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        results: [
          { index: 2, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.52 },
        ],
      }),
      { status: 200 },
    )));

    const store = {
      isFtsAvailable: () => true,
      searchL1Fts: vi.fn(async (_query: string, limit?: number): Promise<L1FtsResult[]> => {
        expect(limit).toBeGreaterThanOrEqual(6);
        return [
          makeFtsResult("a", "无关的天气记录", 0.9),
          makeFtsResult("b", "用户喜欢 Python", 0.89),
          makeFtsResult("c", "用户明确偏好 TypeScript", 0.88),
        ];
      }),
    } as unknown as IMemoryStore;

    const cfg = parseConfig({
      recall: {
        strategy: "keyword",
        maxResults: 2,
        scoreThreshold: 0,
        rerank: {
          enabled: true,
          baseUrl: "https://api.example.com/v1",
          apiKey: "test-key",
          model: "bge-reranker-v2-m3",
          candidateMultiplier: 3,
        },
      },
    });

    const result = await performAutoRecall({
      userText: "TypeScript 偏好",
      actorId: "user",
      sessionKey: "session",
      cfg,
      pluginDataDir: dataDir,
      vectorStore: store,
    });

    const injected = extractRelevantMemoryLines(result?.prependContext);
    expect(injected).toContain("用户明确偏好 TypeScript");
    expect(injected).toContain("无关的天气记录");
    expect(injected).not.toContain("用户喜欢 Python");
    expect(injected.indexOf("用户明确偏好 TypeScript")).toBeLessThan(
      injected.indexOf("无关的天气记录"),
    );
  });
});

function makeFtsResult(id: string, content: string, score: number): L1FtsResult {
  return {
    record_id: id,
    content,
    type: "episodic",
    priority: 80,
    scene_name: "test",
    score,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    session_key: "session",
    session_id: "session-1",
    metadata_json: "{}",
  };
}

function extractRelevantMemoryLines(prependContext: string | undefined): string {
  const match = prependContext?.match(
    /<relevant-memories>[\s\S]*?\n\n([\s\S]*?)\n<\/relevant-memories>/,
  );
  return match?.[1] ?? "";
}
