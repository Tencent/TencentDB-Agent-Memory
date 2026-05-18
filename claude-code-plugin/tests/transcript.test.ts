import { describe, it, expect } from "vitest";
import { readLatestTurn, readAllTurns, parseTranscriptLine } from "../lib/transcript.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, unlink } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/transcript-sample.jsonl");

describe("parseTranscriptLine", () => {
  it("parses a user message", () => {
    const line = '{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u1"}';
    const parsed = parseTranscriptLine(line);
    expect(parsed).toEqual({
      type: "user",
      role: "user",
      content: "hi",
      contentIsArray: false,
      uuid: "u1",
    });
  });

  it("parses an assistant message", () => {
    const line = '{"type":"assistant","message":{"role":"assistant","content":"hello"},"uuid":"a1"}';
    const parsed = parseTranscriptLine(line);
    expect(parsed?.role).toBe("assistant");
    expect(parsed?.content).toBe("hello");
  });

  it("returns null for malformed JSON", () => {
    expect(parseTranscriptLine("{ not json }")).toBeNull();
  });

  it("returns null for messages without content", () => {
    const line = '{"type":"user","message":{"role":"user"},"uuid":"u1"}';
    expect(parseTranscriptLine(line)).toBeNull();
  });

  it("handles content array (multi-part messages) by joining strings", () => {
    const line = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"},{"type":"text","text":"world"}]},"uuid":"u1"}';
    const parsed = parseTranscriptLine(line);
    expect(parsed?.content).toBe("hello\nworld");
    expect(parsed?.contentIsArray).toBe(true);
  });

  it("marks string content as contentIsArray=false", () => {
    const line = '{"type":"user","message":{"role":"user","content":"plain text"},"uuid":"u1"}';
    const parsed = parseTranscriptLine(line);
    expect(parsed?.contentIsArray).toBe(false);
  });
});

describe("readLatestTurn", () => {
  it("returns the most recent user/assistant pair", async () => {
    const turn = await readLatestTurn(FIXTURE);
    expect(turn).not.toBeNull();
    expect(turn!.user).toBe("second question");
    expect(turn!.assistant).toBe("second answer");
  });

  it("returns null for a missing file", async () => {
    const turn = await readLatestTurn("/tmp/nonexistent-transcript-tdai.jsonl");
    expect(turn).toBeNull();
  });

  it("returns null for an empty file", async () => {
    const tmpPath = resolve(__dirname, "fixtures/empty.jsonl");
    await writeFile(tmpPath, "");
    try {
      const turn = await readLatestTurn(tmpPath);
      expect(turn).toBeNull();
    } finally {
      await unlink(tmpPath);
    }
  });

  it("merges multi-part assistant responses split by tool cycles", async () => {
    const tmpPath = resolve(__dirname, "fixtures/multi-part.jsonl");
    const lines = [
      '{"type":"user","message":{"role":"user","content":"search deepseek"},"uuid":"u1"}',
      '{"type":"assistant","message":{"role":"assistant","content":"Searching for DeepSeek info..."},"uuid":"a1"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"search results here"}]},"uuid":"tr1"}',
      '{"type":"assistant","message":{"role":"assistant","content":"DeepSeek V4 is a large MoE model with 685B parameters."},"uuid":"a2"}',
    ];
    await writeFile(tmpPath, lines.join("\n"));
    try {
      const turn = await readLatestTurn(tmpPath);
      expect(turn).not.toBeNull();
      expect(turn!.user).toBe("search deepseek");
      expect(turn!.assistant).toContain("Searching for DeepSeek");
      expect(turn!.assistant).toContain("685B parameters");
    } finally {
      await unlink(tmpPath);
    }
  });
});

describe("readAllTurns", () => {
  it("returns all turns from the fixture", async () => {
    const turns = await readAllTurns(FIXTURE);
    expect(turns).toHaveLength(2);
    expect(turns[0].user).toBe("first question");
    expect(turns[0].assistant).toBe("first answer");
    expect(turns[1].user).toBe("second question");
    expect(turns[1].assistant).toBe("second answer");
  });

  it("returns empty array for missing file", async () => {
    const turns = await readAllTurns("/tmp/nonexistent.jsonl");
    expect(turns).toEqual([]);
  });

  it("does not split turn on skill output (array-content user entry)", async () => {
    const tmpPath = resolve(__dirname, "fixtures/skill-output.jsonl");
    const lines = [
      '{"type":"user","message":{"role":"user","content":"search deepseek v4"},"uuid":"u1"}',
      '{"type":"assistant","message":{"role":"assistant","content":"Searching with Tavily..."},"uuid":"a1"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Skill"}]},"uuid":"a2"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"skill launched"}]},"uuid":"tr1"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: /path/to/skill\\n\\n# tavily search\\n\\nSearch the web..."}]},"uuid":"sk1"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Bash"}]},"uuid":"a3"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"search results here 15000 chars"}]},"uuid":"tr2"}',
      '{"type":"assistant","message":{"role":"assistant","content":"## DeepSeek V4 Summary\\n\\nDeepSeek V4 launched with 1.6T parameters."},"uuid":"a4"}',
    ];
    await writeFile(tmpPath, lines.join("\n"));
    try {
      const turns = await readAllTurns(tmpPath);
      expect(turns).toHaveLength(1);
      expect(turns[0].user).toBe("search deepseek v4");
      expect(turns[0].assistant).toContain("Searching with Tavily");
      expect(turns[0].assistant).toContain("DeepSeek V4 Summary");
      expect(turns[0].assistant).toContain("1.6T parameters");
    } finally {
      await unlink(tmpPath);
    }
  });

  it("merges multi-part assistant responses across tool cycles", async () => {
    const tmpPath = resolve(__dirname, "fixtures/allturns-multi.jsonl");
    const lines = [
      '{"type":"user","message":{"role":"user","content":"q1"},"uuid":"u1"}',
      '{"type":"assistant","message":{"role":"assistant","content":"a1"},"uuid":"a1"}',
      '{"type":"user","message":{"role":"user","content":"q2"},"uuid":"u2"}',
      '{"type":"assistant","message":{"role":"assistant","content":"part1"},"uuid":"a2"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"tool output"}]},"uuid":"tr1"}',
      '{"type":"assistant","message":{"role":"assistant","content":"part2 with details"},"uuid":"a3"}',
    ];
    await writeFile(tmpPath, lines.join("\n"));
    try {
      const turns = await readAllTurns(tmpPath);
      expect(turns).toHaveLength(2);
      expect(turns[0]).toEqual({ user: "q1", assistant: "a1" });
      expect(turns[1].user).toBe("q2");
      expect(turns[1].assistant).toContain("part1");
      expect(turns[1].assistant).toContain("part2 with details");
    } finally {
      await unlink(tmpPath);
    }
  });
});
