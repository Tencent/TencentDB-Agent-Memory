import { afterEach, describe, expect, it, vi } from "vitest";

import type { IMemoryStore, L1FtsResult } from "../store/types.js";
import { executeMemorySearch } from "./memory-search.js";

describe("executeMemorySearch rerank", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reranks tool search candidates before trimming to the requested limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        results: [
          { index: 2, score: 0.93 },
          { index: 0, score: 0.42 },
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

    const result = await executeMemorySearch({
      query: "TypeScript 偏好",
      limit: 2,
      vectorStore: store,
      rerank: {
        enabled: true,
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "bge-reranker-v2-m3",
        timeoutMs: 1000,
        candidateMultiplier: 3,
      },
    });

    expect(result.results.map((item) => item.id)).toEqual(["c", "a"]);
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
