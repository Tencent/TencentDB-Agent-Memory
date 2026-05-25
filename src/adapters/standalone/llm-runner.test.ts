import { beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: generateTextMock,
  };
});

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({
    chat: (model: string) => ({ model }),
  }),
}));

describe("StandaloneLLMRunner", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({ text: "[]", steps: [] });
  });

  it("does not expose tools when enableTools is false", async () => {
    const { StandaloneLLMRunner } = await import("./llm-runner.js");
    const runner = new StandaloneLLMRunner({
      config: {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        model: "deepseek-ai/DeepSeek-V4-Flash",
      },
      enableTools: false,
    });

    await runner.run({ prompt: "return JSON", taskId: "l1" });

    expect(generateTextMock).toHaveBeenCalledOnce();
    expect(generateTextMock.mock.calls[0]![0]).not.toHaveProperty("tools");
  });

  it("passes configured provider options to disable provider thinking modes", async () => {
    const { StandaloneLLMRunner } = await import("./llm-runner.js");
    const runner = new StandaloneLLMRunner({
      config: {
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        model: "deepseek-ai/DeepSeek-V4-Flash",
        providerOptions: {
          openai: {
            extraBody: {
              enable_thinking: false,
            },
          },
        },
      },
      enableTools: false,
    });

    await runner.run({ prompt: "return JSON", taskId: "l1" });

    expect(generateTextMock.mock.calls[0]![0]).toMatchObject({
      providerOptions: {
        openai: {
          extraBody: {
            enable_thinking: false,
          },
        },
      },
    });
  });
});
