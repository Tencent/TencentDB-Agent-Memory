import { afterEach, describe, expect, test, vi } from "vitest";

import { OpenAIEmbeddingService } from "./embedding.js";

describe("OpenAIEmbeddingService provider adapters", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("calls ZeroEntropy native embed API and parses results embeddings", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({
        results: [
          { embedding: [3, 4] },
          { embedding: [0, 5] },
        ],
      }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const service = new OpenAIEmbeddingService({
      provider: "zeroentropy",
      baseUrl: "https://api.zeroentropy.dev/",
      apiKey: "ze-key",
      model: "zembed-1",
      dimensions: 2,
    });

    const embeddings = await service.embedBatch(["query one", "query two"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.zeroentropy.dev/v1/models/embed");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      input: ["query one", "query two"],
      input_type: "query",
      model: "zembed-1",
    });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer ze-key",
    });
    expect(Array.from(embeddings[0])).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(Array.from(embeddings[1])).toEqual([0, 1]);
  });
});
