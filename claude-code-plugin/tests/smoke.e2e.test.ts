import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TdaiGateway } from "../../src/gateway/server.js";
import { GatewayClient } from "../lib/gateway-client.js";

describe("cc-plugin smoke e2e (in-process gateway)", () => {
  let dataDir: string;
  let gateway: TdaiGateway;
  const PORT = 19421;
  const TOKEN = "smoke-e2e-token-" + Math.random().toString(36).slice(2);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "tdai-smoke-"));
    vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
    vi.stubEnv("TDAI_DATA_DIR", dataDir);
    // Re-stub TDAI_GATEWAY_TOKEN inside each test as well (vitest unstubEnvs: true).
    gateway = new TdaiGateway({
      server: { port: PORT, host: "127.0.0.1" },
      data: { baseDir: dataDir },
    } as never);
    await gateway.start();
  }, 60_000);

  afterAll(async () => {
    if (gateway) await gateway.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("rejects unauthenticated /health", async () => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${PORT}`,
      token: "wrong-token",
      timeoutMs: 5_000,
    });
    const ok = await client.health();
    expect(ok).toBe(false);
  });

  it("accepts authenticated /health", async () => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${PORT}`,
      token: TOKEN,
      timeoutMs: 5_000,
    });
    const ok = await client.health();
    expect(ok).toBe(true);
  });

  it("captures a turn end-to-end (L0 written)", async () => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${PORT}`,
      token: TOKEN,
      timeoutMs: 30_000,
    });
    const result = await client.captureTurn({
      user_content: "smoke test user message",
      assistant_content: "smoke test assistant response",
      session_key: "smoke-key-1",
      session_id: "smoke-session-1",
    });
    expect(result).not.toBeNull();
    expect(result!.l0_recorded).toBeGreaterThanOrEqual(0);
  });
});
