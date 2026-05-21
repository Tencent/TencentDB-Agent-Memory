import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { parseConfig } from "../../config.js";
import { createStoreBundle } from "./factory.js";

describe("createStoreBundle", () => {
  const originalFetch = globalThis.fetch;
  let dataDir: string | undefined;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  test("passes proxy and timeout options to remote embedding service", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "memory-tdai-store-"));
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: [1, 0] }],
      }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const bundle = createStoreBundle(parseConfig({
      embedding: {
        provider: "qclaw",
        proxyUrl: "http://127.0.0.1:8787/proxy",
        baseUrl: "https://embedding.example/v1",
        apiKey: "qclaw-key",
        model: "qclaw-embedding",
        dimensions: 2,
        timeoutMs: 1234,
      },
    }), { dataDir });

    try {
      await bundle.embedding.embed("hello");
    } finally {
      bundle.store.close();
    }

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8787/proxy");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      "Remote-URL": "https://embedding.example/v1/embeddings",
    });
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1234);
  });
});
