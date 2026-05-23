import { describe, expect, it } from "vitest";

import { formatExtractionPrompt } from "./l1-extraction.js";

describe("formatExtractionPrompt", () => {
  it("formats message timestamps with the configured timezone offset", () => {
    const prompt = formatExtractionPrompt({
      timezoneOffsetMinutes: -300,
      backgroundMessages: [
        {
          id: "bg-1",
          role: "assistant",
          content: "Background message",
          timestamp: Date.parse("2026-01-01T02:00:00.000Z"),
        },
      ],
      newMessages: [
        {
          id: "new-1",
          role: "user",
          content: "User prefers local timestamps in memory prompts.",
          timestamp: Date.parse("2026-01-01T02:30:00.000Z"),
        },
      ],
    });

    expect(prompt).toContain("[2025-12-31T21:00:00.000-05:00]");
    expect(prompt).toContain("[2025-12-31T21:30:00.000-05:00]");
    expect(prompt).not.toContain("2026-01-01T02:30:00.000Z");
  });
});
