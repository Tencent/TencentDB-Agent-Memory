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
});
