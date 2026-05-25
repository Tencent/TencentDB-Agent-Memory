import { describe, expect, it } from "vitest";
import { MemoryPipelineManager } from "./pipeline-manager.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("MemoryPipelineManager stage controls", () => {
  it("exposes disabled L2/L3 stage configuration", () => {
    const manager = new MemoryPipelineManager({
      everyNConversations: 5,
      enableWarmup: true,
      l1: { idleTimeoutSeconds: 600 },
      l2: {
        enabled: false,
        delayAfterL1Seconds: 90,
        minIntervalSeconds: 900,
        maxIntervalSeconds: 3600,
        sessionActiveWindowHours: 24,
      },
      l3: {
        enabled: false,
      },
    }, logger);

    expect(manager.getStageConfig()).toEqual({ l2Enabled: false, l3Enabled: false });
  });
});
