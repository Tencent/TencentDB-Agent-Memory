import { describe, expect, it } from "vitest";
import { executeConversationSearch } from "./conversation-search.js";
import { executeMemorySearch } from "./memory-search.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("session-prefix search filters", () => {
  it("filters L1 memory search results by session-key prefix", async () => {
    const rows = [
      ...Array.from({ length: 700 }, (_, i) => l1Result(`other-${i}`, "codex:def456:session-b")),
      l1Result("a", "codex:abc123:session-a"),
      l1Result("c", "codex-import:abc123:session-c"),
    ];
    const vectorStore = {
      isFtsAvailable: () => true,
      countL1: () => rows.length,
      searchL1Fts: (_query: string, limit: number) => rows.slice(0, limit),
    };

    const result = await executeMemorySearch({
      query: "project note",
      limit: 2,
      sessionKeyPrefixes: ["codex:abc123:", "codex-import:abc123:"],
      vectorStore: vectorStore as any,
      logger,
    });

    expect(result.results.map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("filters L0 conversation search results by session-key prefix", async () => {
    const rows = [
      ...Array.from({ length: 700 }, (_, i) => l0Result(`other-${i}`, "codex:def456:session-b")),
      l0Result("a", "codex:abc123:session-a"),
      l0Result("c", "codex-import:abc123:session-c"),
    ];
    const vectorStore = {
      isFtsAvailable: () => true,
      countL0: () => rows.length,
      searchL0Fts: (_query: string, limit: number) => rows.slice(0, limit),
    };

    const result = await executeConversationSearch({
      query: "previous command",
      limit: 2,
      sessionKeyPrefixes: ["codex:abc123:", "codex-import:abc123:"],
      vectorStore: vectorStore as any,
      logger,
    });

    expect(result.results.map((item) => item.id)).toEqual(["a", "c"]);
  });
});

function l1Result(id: string, sessionKey: string) {
  return {
    record_id: id,
    content: `memory ${id}`,
    type: "episodic",
    priority: 2,
    scene_name: "test",
    score: 1,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    session_key: sessionKey,
    session_id: id,
    metadata_json: "{}",
  };
}

function l0Result(id: string, sessionKey: string) {
  return {
    record_id: id,
    session_key: sessionKey,
    role: "assistant",
    message_text: `conversation ${id}`,
    score: 1,
    recorded_at: "",
  };
}
