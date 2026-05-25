import { describe, expect, it } from "vitest";
import { EXTRACT_MEMORIES_SYSTEM_PROMPT } from "./l1-extraction.js";

describe("EXTRACT_MEMORIES_SYSTEM_PROMPT", () => {
  it("requires every memory to carry an explicit scope", () => {
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain('"scope"');
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("global");
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("project");
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("session");
  });

  it("prevents scene-limited instructions from becoming global rules", () => {
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("场景受限");
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("不得泛化为全局");
  });
});
