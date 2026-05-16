import { describe, expect, it } from "vitest";
import { MemoryPipelineManager, type PipelineConfig } from "./pipeline-manager.js";

function baseConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    enableL2: true,
    enableL3: true,
    enableWarmup: false,
    everyNConversations: 1,
    l1: { idleTimeoutSeconds: 60 },
    l2: {
      delayAfterL1Seconds: 0,
      maxIntervalSeconds: 60,
      minIntervalSeconds: 0,
      sessionActiveWindowHours: 24,
    },
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met");
}

describe("MemoryPipelineManager stage controls", () => {
  it("does not schedule L2 or L3 when both stages are disabled", async () => {
    const manager = new MemoryPipelineManager(baseConfig({
      enableL2: false,
      enableL3: false,
    }));
    let l1Calls = 0;
    let l2Calls = 0;
    let l3Calls = 0;

    manager.setL1Runner(async () => {
      l1Calls += 1;
    });
    manager.setL2Runner(async () => {
      l2Calls += 1;
    });
    manager.setL3Runner(async () => {
      l3Calls += 1;
    });
    manager.start({});

    await manager.notifyConversation("session-1", [
      { role: "user", content: "remember this", timestamp: new Date().toISOString() },
    ]);
    await waitFor(() => l1Calls === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(l2Calls).toBe(0);
    expect(l3Calls).toBe(0);
    expect(manager.getQueueSizes()).toMatchObject({
      l2: 0,
      l2Pending: false,
      l3: 0,
      l3Pending: false,
    });

    await manager.destroy();
  });
});
