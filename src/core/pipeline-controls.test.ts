import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, TdaiCore } from "./index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-tdai-pipeline-controls-"));
  tempDirs.push(dir);
  return dir;
}

function createHostAdapter(dataDir: string, runnerCalls: Array<{ enableTools: boolean }>) {
  return {
    hostType: "standalone" as const,
    getLLMRunnerFactory: () => ({
      createRunner: (options: { enableTools?: boolean } = {}) => {
        runnerCalls.push({ enableTools: options.enableTools ?? false });
        return { run: async () => "" };
      },
    }),
    getLogger: () => ({
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: () => {},
    }),
    getRuntimeContext: () => ({
      dataDir,
      platform: "vitest",
      sessionId: "session-1",
      sessionKey: "chat-1:session-1",
      userId: "user-1",
      workspaceDir: "/tmp/workspace",
    }),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("pipeline controls", () => {
  it("defaults L2 and L3 pipeline stages to enabled", () => {
    const config = parseConfig({});

    expect(config.pipeline.enableL2).toBe(true);
    expect(config.pipeline.enableL3).toBe(true);
  });

  it("can enable L1 extraction without creating tool-enabled L2/L3 runners", async () => {
    const runnerCalls: Array<{ enableTools: boolean }> = [];
    const config = parseConfig({
      extraction: { enabled: true },
      pipeline: {
        enableL2: false,
        enableL3: false,
        enableWarmup: false,
      },
    });
    const core = new TdaiCore({
      config,
      hostAdapter: createHostAdapter(makeTempDir(), runnerCalls),
    });

    await core.initialize();
    await core.destroy();

    expect(runnerCalls).toEqual([{ enableTools: false }]);
    expect(core.getScheduler()?.getQueueSizes()).toMatchObject({
      l2: 0,
      l2Pending: false,
      l3: 0,
      l3Pending: false,
    });
  });
});
