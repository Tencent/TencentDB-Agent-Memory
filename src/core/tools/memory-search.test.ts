import { describe, expect, it } from "vitest";
import type { IMemoryStore, L1FtsResult } from "../store/types.js";
import { executeMemorySearch } from "./memory-search.js";

function l1Result(params: {
  content: string;
  recordId: string;
  sessionKey: string;
}): L1FtsResult {
  return {
    content: params.content,
    metadata_json: "{}",
    priority: 50,
    record_id: params.recordId,
    scene_name: "review",
    score: 0.9,
    session_id: `${params.sessionKey}:sub`,
    session_key: params.sessionKey,
    timestamp_end: "2026-05-16T00:00:00.000Z",
    timestamp_start: "2026-05-16T00:00:00.000Z",
    timestamp_str: "2026-05-16",
    type: "preference",
  };
}

describe("memory search scope", () => {
  it("filters L1 FTS results by sessionKey before formatting", async () => {
    const vectorStore = {
      isFtsAvailable: () => true,
      searchL1Fts: async () => [
        l1Result({
          content: "Refresh project prefers strict code review.",
          recordId: "refresh-review-style",
          sessionKey: "refresh-project",
        }),
        l1Result({
          content: "Other project prefers loose review.",
          recordId: "other-review-style",
          sessionKey: "other-project",
        }),
      ],
    } as Partial<IMemoryStore> as IMemoryStore;

    const result = await executeMemorySearch({
      limit: 5,
      query: "review style",
      sessionKey: "refresh-project",
      vectorStore,
    });

    expect(result.total).toBe(1);
    expect(result.results.map((item) => item.content)).toEqual([
      "Refresh project prefers strict code review.",
    ]);
  });
});
