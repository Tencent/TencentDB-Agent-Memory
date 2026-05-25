import { describe, expect, it } from "vitest";
import { parseProviderModelRef } from "./index.js";

describe("parseProviderModelRef", () => {
  it("splits provider and model at the first slash only", () => {
    expect(parseProviderModelRef("siliconflow/deepseek-ai/DeepSeek-V4-Flash")).toEqual({
      providerKey: "siliconflow",
      modelId: "deepseek-ai/DeepSeek-V4-Flash",
    });
  });

  it("uses the whole reference as modelId when no provider prefix exists", () => {
    expect(parseProviderModelRef("DeepSeek-V4-Flash")).toEqual({
      providerKey: "",
      modelId: "DeepSeek-V4-Flash",
    });
  });
});
