import { describe, expect, it, vi, afterEach } from "vitest";
import { MemoryPipelineManager } from "./pipeline-manager.js";
import type { CapturedMessage } from "./pipeline-manager.js";
import type { Logger } from "../core/types.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const message = (): CapturedMessage => ({
  role: "user",
  content: "hello",
  timestamp: new Date().toISOString(),
});

describe("MemoryPipelineManager L2 scheduling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies minInterval throttling after a skipped L2 run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));

    const manager = new MemoryPipelineManager(
      {
        everyNConversations: 1,
        enableWarmup: false,
        l1: { idleTimeoutSeconds: 60 },
        l2: {
          delayAfterL1Seconds: 0,
          minIntervalSeconds: 60,
          maxIntervalSeconds: 3600,
          sessionActiveWindowHours: 24,
        },
      },
      silentLogger,
    );

    manager.setL1Runner(async () => {});
    const l2Runner = vi.fn(async () => ({ skipped: true }));
    manager.setL2Runner(l2Runner);

    await manager.notifyConversation("session-a", [message()]);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    expect(l2Runner).toHaveBeenCalledTimes(1);

    await manager.notifyConversation("session-a", [message()]);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(l2Runner).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();
    expect(l2Runner).toHaveBeenCalledTimes(2);

    await manager.destroy();
  });
});
