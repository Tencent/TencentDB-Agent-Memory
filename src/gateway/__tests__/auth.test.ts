import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import http from "node:http";
import { TdaiGateway } from "../server.js";

async function request(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Gateway optional Bearer token", () => {
  let gateway: TdaiGateway;
  const PORT = 18421;
  const TOKEN = "test-token-abc-123";

  beforeAll(async () => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
    gateway = new TdaiGateway({
      server: { port: PORT, host: "127.0.0.1" },
    } as never);
    await gateway.start();
  });

  // vitest config has `unstubEnvs: true`, which resets stubs before each test.
  // Re-stub here so the middleware (which reads process.env per-request) sees the token.
  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it("rejects unauthenticated requests with 401 when token is configured", async () => {
    const res = await request(PORT, "/health");
    expect(res.status).toBe(401);
  });

  it("rejects wrong token with 401", async () => {
    const res = await request(PORT, "/health", {
      Authorization: "Bearer wrong-token",
    });
    expect(res.status).toBe(401);
  });

  it("accepts correct Bearer token", async () => {
    const res = await request(PORT, "/health", {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(200);
  });

  it("allows OPTIONS preflight without token (CORS)", async () => {
    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: PORT,
          path: "/recall",
          method: "OPTIONS",
        },
        (res) => {
          expect(res.statusCode).toBe(204);
          resolve();
        },
      );
      req.on("error", reject);
      req.end();
    });
  });
});

describe("Gateway with no token configured", () => {
  let gateway: TdaiGateway;
  const PORT = 18422;

  beforeAll(async () => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    gateway = new TdaiGateway({
      server: { port: PORT, host: "127.0.0.1" },
    } as never);
    await gateway.start();
  });

  // vitest config has `unstubEnvs: true`; re-stub each test so middleware sees empty token.
  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it("accepts unauthenticated requests when token is empty (backward compat)", async () => {
    const res = await request(PORT, "/health");
    expect(res.status).toBe(200);
  });
});
