import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getRerankCandidateLimit,
  isRerankConfigured,
  rerankCandidates,
} from "./reranker.js";

describe("recall reranker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps original top results when rerank is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const candidates = [
      { id: "a", text: "用户喜欢 TypeScript" },
      { id: "b", text: "用户喜欢 Python" },
      { id: "c", text: "用户喜欢 Rust" },
    ];

    const result = await rerankCandidates({
      query: "TypeScript 偏好",
      candidates,
      topN: 2,
      config: { enabled: false },
      getDocumentText: (item) => item.text,
    });

    expect(result.map((item) => item.id)).toEqual(["a", "b"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isRerankConfigured({ enabled: false })).toBe(false);
    expect(getRerankCandidateLimit(5, { enabled: false })).toBe(5);
  });

  it("reorders candidates with remote relevance scores", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toEqual({
        model: "bge-reranker-v2-m3",
        query: "TypeScript 偏好",
        documents: [
          "无关的天气记录",
          "用户喜欢 Python",
          "用户明确偏好 TypeScript",
        ],
        top_n: 2,
      });

      return new Response(
        JSON.stringify({
          results: [
            { index: 2, relevance_score: 0.92 },
            { index: 1, relevance_score: 0.41 },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const candidates = [
      { id: "a", text: "无关的天气记录" },
      { id: "b", text: "用户喜欢 Python" },
      { id: "c", text: "用户明确偏好 TypeScript" },
    ];

    const result = await rerankCandidates({
      query: "TypeScript 偏好",
      candidates,
      topN: 2,
      config: {
        enabled: true,
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "bge-reranker-v2-m3",
        timeoutMs: 1000,
        candidateMultiplier: 4,
      },
      getDocumentText: (item) => item.text,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/rerank",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(result.map((item) => item.id)).toEqual(["c", "b"]);
    expect(getRerankCandidateLimit(5, {
      enabled: true,
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "bge-reranker-v2-m3",
      candidateMultiplier: 4,
    })).toBe(20);
  });

  it("falls back to original top results when remote rerank fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    const warn = vi.fn();

    const candidates = [
      { id: "a", text: "第一条" },
      { id: "b", text: "第二条" },
      { id: "c", text: "第三条" },
    ];

    const result = await rerankCandidates({
      query: "查询",
      candidates,
      topN: 2,
      config: {
        enabled: true,
        baseUrl: "https://api.example.com/v1/rerank",
        apiKey: "test-key",
        model: "reranker",
        timeoutMs: 1000,
      },
      getDocumentText: (item) => item.text,
      logger: { warn, info: vi.fn(), error: vi.fn() },
    });

    expect(result.map((item) => item.id)).toEqual(["a", "b"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Remote rerank failed"));
  });
});
