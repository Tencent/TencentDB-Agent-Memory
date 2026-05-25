import { describe, expect, it, vi } from "vitest";

import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { ExtractedMemory } from "./l1-writer.js";
import { preExtractMemories, mergeExtractedMemories } from "./pre-extractor.js";
import { callLlmExtraction, passesConfidenceCheck } from "./l1-extractor.js";

// ============================
// Helpers
// ============================

function makeMsg(
  id: string,
  content: string,
  role: "user" | "assistant" = "user",
): ConversationMessage {
  return { id, role, content, timestamp: Date.now() };
}

function makeExtractedMemory(
  content: string,
  type: "persona" | "episodic" | "instruction" = "episodic",
  sourceIds: string[] = [],
): ExtractedMemory {
  return {
    content,
    type,
    priority: 80,
    source_message_ids: sourceIds,
    metadata: {},
    scene_name: "test-scene",
  };
}

// ============================
// Tests
// ============================

describe("preExtractMemories", () => {
  it("only extracts from newMessages, not background messages", () => {
    const newMessages: ConversationMessage[] = [
      makeMsg("m1", "我是前端工程师"),
    ];
    const backgroundMessages: ConversationMessage[] = [
      makeMsg("bg1", "我喜欢吃川菜"),
    ];

    const result = preExtractMemories(newMessages);

    // newMessage's pattern should be detected
    expect(result.direct.length).toBeGreaterThanOrEqual(1);
    expect(result.direct.some((m) => m.content.includes("前端工程师"))).toBe(true);

    // Background pattern IS detectable in isolation (MEDIUM confidence)
    const bgResult = preExtractMemories(backgroundMessages);
    const bgMatches = [...bgResult.direct, ...bgResult.hints];
    expect(bgMatches.some((m) => m.content.includes("川菜"))).toBe(true);

    // But the newMessages-only result should NOT contain background pattern
    const allMatches = [...result.direct, ...result.hints];
    expect(allMatches.some((m) => m.content.includes("川菜"))).toBe(false);
  });

  it("correctly detects HIGH-confidence persona patterns", () => {
    const messages: ConversationMessage[] = [makeMsg("m1", "我是产品经理")];

    const result = preExtractMemories(messages);

    expect(result.direct.length).toBe(1);
    expect(result.direct[0]).toMatchObject({
      content: "用户是产品经理",
      type: "persona",
      confidence: "HIGH",
    });
    expect(result.direct[0].priority).toBe(80);
  });

  it("correctly detects HIGH-confidence instruction patterns", () => {
    const messages: ConversationMessage[] = [makeMsg("m1", "以后都用中文回复我")];

    const result = preExtractMemories(messages);

    expect(result.direct.length).toBe(1);
    expect(result.direct[0]).toMatchObject({
      type: "instruction",
      confidence: "HIGH",
    });
    expect(result.direct[0].content).toContain("中文");
  });
});

describe("mergeExtractedMemories", () => {
  it("deduplicates: rule extraction merged only once with LLM results", () => {
    const llmMemories: ExtractedMemory[] = [
      makeExtractedMemory("用户是前端工程师", "persona", ["m1"]),
    ];

    const preResult = preExtractMemories([makeMsg("m1", "我是前端工程师")]);

    const merged = mergeExtractedMemories(llmMemories, preResult);

    const personaMemories = merged.filter((m) =>
      m.content.includes("前端工程师"),
    );
    expect(personaMemories.length).toBe(1);
  });

  it("adds new HIGH-confidence items not found in LLM results", () => {
    const llmMemories: ExtractedMemory[] = [
      makeExtractedMemory("用户讨论了部署流程", "episodic", ["m1"]),
    ];

    const preResult = preExtractMemories([makeMsg("m1", "我是后端工程师")]);

    const merged = mergeExtractedMemories(llmMemories, preResult);

    expect(merged.length).toBeGreaterThanOrEqual(2);
    expect(merged.some((m) => m.content.includes("后端工程师"))).toBe(true);
    expect(merged.some((m) => m.content.includes("部署流程"))).toBe(true);
  });
});

describe("callLlmExtraction", () => {
  it("retries exactly once when first response is malformed JSON", async () => {
    let callCount = 0;

    const mockRunner = {
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return "not valid json at all";
        }
        return JSON.stringify([
          { scene_name: "test", message_ids: ["m1"], memories: [] },
        ]);
      }),
    };

    const scenes = await callLlmExtraction({
      newMessages: [makeMsg("m1", "hello")],
      backgroundMessages: [],
      config: {},
      llmRunner: mockRunner,
    });

    expect(callCount).toBe(2);
    expect(scenes.length).toBe(1);
    expect(scenes[0].scene_name).toBe("test");
  });

  it("does NOT retry more than once", async () => {
    let callCount = 0;

    const mockRunner = {
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        return "still not json {{broken";
      }),
    };

    const scenes = await callLlmExtraction({
      newMessages: [makeMsg("m1", "hello")],
      backgroundMessages: [],
      config: {},
      llmRunner: mockRunner,
    });

    expect(callCount).toBe(2);
    expect(scenes.length).toBe(0);
  });
});

describe("passesConfidenceCheck", () => {
  it("accepts valid persona memory with user reference", () => {
    const mem: ExtractedMemory = makeExtractedMemory(
      "用户是前端工程师",
      "persona",
      ["m1"],
    );
    const messages: ConversationMessage[] = [makeMsg("m1", "我是前端工程师")];

    expect(passesConfidenceCheck(mem, messages)).toBe(true);
  });

  it("accepts valid instruction memory with directive words", () => {
    const mem: ExtractedMemory = makeExtractedMemory(
      "用户要求 AI 使用中文回复",
      "instruction",
      ["m1"],
    );
    const messages: ConversationMessage[] = [makeMsg("m1", "以后都用中文回复")];

    expect(passesConfidenceCheck(mem, messages)).toBe(true);
  });

  it("rejects persona memory without user reference", () => {
    const mem: ExtractedMemory = makeExtractedMemory(
      "前端工程师",
      "persona",
      ["m1"],
    );
    const messages: ConversationMessage[] = [makeMsg("m1", "前端工程师")];

    expect(passesConfidenceCheck(mem, messages)).toBe(false);
  });

  it("rejects too-short CJK content", () => {
    const mem: ExtractedMemory = makeExtractedMemory("你好", "episodic", ["m1"]);
    const messages: ConversationMessage[] = [makeMsg("m1", "你好")];

    expect(passesConfidenceCheck(mem, messages)).toBe(false);
  });
});
