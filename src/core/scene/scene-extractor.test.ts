import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { LLMRunParams, LLMRunner } from "../types.js";
import { SceneExtractor } from "./scene-extractor.js";

describe("SceneExtractor timezone", () => {
  it("injects the current timestamp with the configured timezone offset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T02:30:00.000Z"));
    const baseDir = await mkdtemp(path.join(tmpdir(), "tdai-scene-tz-"));
    let capturedPrompt = "";

    const llmRunner: LLMRunner = {
      async run(params: LLMRunParams): Promise<string> {
        capturedPrompt = params.prompt;
        return "";
      },
    };

    try {
      const extractor = new SceneExtractor({
        dataDir: baseDir,
        config: {},
        maxScenes: 5,
        llmRunner,
        timezoneOffsetMinutes: -300,
      });

      const result = await extractor.extract([
        {
          id: "memory-1",
          content: "User enabled configurable timezone timestamps.",
          created_at: "2026-01-01T02:00:00.000Z",
        },
      ]);

      expect(result.success).toBe(true);
      expect(capturedPrompt).toContain("2025-12-31T21:30:00.000-05:00");
      expect(capturedPrompt).not.toContain("2026-01-01T02:30:00.000Z");
    } finally {
      vi.useRealTimers();
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
