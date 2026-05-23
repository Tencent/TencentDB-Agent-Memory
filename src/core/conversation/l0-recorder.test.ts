import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { recordConversation } from "./l0-recorder.js";

describe("recordConversation timezone", () => {
  it("writes recordedAt and shard filename in the configured timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T02:30:00.000Z"));
    const baseDir = await mkdtemp(path.join(tmpdir(), "tdai-l0-tz-"));

    try {
      await recordConversation({
        sessionKey: "session-a",
        sessionId: "sid-a",
        rawMessages: [
          {
            id: "msg-1",
            role: "user",
            content: "User wants local timezone timestamps in recorded memory data.",
            timestamp: Date.parse("2026-01-01T02:29:00.000Z"),
          },
        ],
        baseDir,
        timezoneOffsetMinutes: -300,
      });

      const raw = await readFile(
        path.join(baseDir, "conversations", "2025-12-31.jsonl"),
        "utf-8",
      );
      const record = JSON.parse(raw.trim()) as { recordedAt: string };

      expect(record.recordedAt).toBe("2025-12-31T21:30:00.000-05:00");
    } finally {
      vi.useRealTimers();
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
