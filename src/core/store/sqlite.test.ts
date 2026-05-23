import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { VectorStore } from "./sqlite.js";

describe("VectorStore L0 cursor queries", () => {
  it("compares recorded_at cursors by instant instead of ISO string order", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tdai-sqlite-tz-"));
    const store = new VectorStore(path.join(dir, "memory.db"), 0);

    try {
      store.init({ provider: "none", model: "", dimensions: 0 });
      expect(store.isDegraded()).toBe(false);

      expect(store.upsertL0({
        id: "l0-1",
        sessionKey: "session-a",
        sessionId: "sid-a",
        role: "user",
        messageText: "First message with a negative timezone offset.",
        recordedAt: "2025-12-31T21:30:00.000-05:00",
        timestamp: Date.parse("2026-01-01T02:29:00.000Z"),
      })).toBe(true);
      expect(store.upsertL0({
        id: "l0-2",
        sessionKey: "session-a",
        sessionId: "sid-a",
        role: "assistant",
        messageText: "Second message should be returned after the cursor.",
        recordedAt: "2025-12-31T21:31:00.000-05:00",
        timestamp: Date.parse("2026-01-01T02:30:00.000Z"),
      })).toBe(true);

      const rows = store.queryL0ForL1(
        "session-a",
        Date.parse("2025-12-31T21:30:00.000-05:00"),
        10,
      );

      expect(rows.map((r) => r.record_id)).toEqual(["l0-2"]);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
