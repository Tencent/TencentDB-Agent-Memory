import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("parses secure offload backend TLS options", () => {
    const cfg = parseConfig({
      offload: {
        allowInsecureTls: true,
        backendCaPemPath: "/tmp/custom-ca.pem",
      },
    });

    expect(cfg.offload.allowInsecureTls).toBe(true);
    expect(cfg.offload.backendCaPemPath).toBe("/tmp/custom-ca.pem");
  });

  it("parses standalone LLM provider options used to disable thinking", () => {
    const cfg = parseConfig({
      llm: {
        providerOptions: {
          openai: {
            extraBody: {
              enable_thinking: false,
            },
          },
        },
      },
    });

    expect(cfg.llm.providerOptions).toEqual({
      openai: {
        extraBody: {
          enable_thinking: false,
        },
      },
    });
  });

  it("parses independent L2 and L3 pipeline stage switches", () => {
    const cfg = parseConfig({
      pipeline: {
        enableL2: false,
        enableL3: false,
      },
    });

    expect(cfg.pipeline.enableL2).toBe(false);
    expect(cfg.pipeline.enableL3).toBe(false);
  });

  it("parses ZeroEntropy embedding provider configuration", () => {
    const cfg = parseConfig({
      embedding: {
        provider: "zeroentropy",
        baseUrl: "https://api.zeroentropy.dev",
        apiKey: "ze-key",
        model: "zembed-1",
        dimensions: 2560,
      },
    });

    expect(cfg.embedding.enabled).toBe(true);
    expect(cfg.embedding.provider).toBe("zeroentropy");
    expect(cfg.embedding.baseUrl).toBe("https://api.zeroentropy.dev");
    expect(cfg.embedding.model).toBe("zembed-1");
    expect(cfg.embedding.dimensions).toBe(2560);
    expect(cfg.embedding.configError).toBeUndefined();
  });
});
