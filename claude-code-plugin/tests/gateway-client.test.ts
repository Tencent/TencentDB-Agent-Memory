import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { GatewayClient } from "../lib/gateway-client.js";

interface CapturedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function startStubServer(
  handler: (req: CapturedRequest) => { status: number; body: unknown },
): Promise<{ port: number; close: () => Promise<void>; captured: CapturedRequest[] }> {
  return new Promise((resolve) => {
    const captured: CapturedRequest[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const captured1: CapturedRequest = {
          method: req.method ?? "",
          path: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf-8"),
        };
        captured.push(captured1);
        const { status, body } = handler(captured1);
        const json = JSON.stringify(body);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(json);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
        captured,
      });
    });
  });
}

describe("GatewayClient", () => {
  let stub: Awaited<ReturnType<typeof startStubServer>>;

  afterEach(async () => {
    if (stub) await stub.close();
  });

  it("sends Authorization: Bearer <token> on health probe", async () => {
    stub = await startStubServer(() => ({
      status: 200,
      body: { status: "ok", version: "x", uptime: 1 },
    }));

    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      token: "secret-123",
    });
    const ok = await client.health();
    expect(ok).toBe(true);
    expect(stub.captured[0].headers.authorization).toBe("Bearer secret-123");
  });

  it("health returns false on non-200", async () => {
    stub = await startStubServer(() => ({ status: 500, body: { error: "x" } }));
    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      token: "t",
    });
    expect(await client.health()).toBe(false);
  });

  it("health returns false on connection error", async () => {
    const client = new GatewayClient({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
    });
    expect(await client.health()).toBe(false);
  });

  it("recall POSTs query and session_key, returns context string", async () => {
    stub = await startStubServer(() => ({
      status: 200,
      body: { context: "recalled-content", strategy: "hybrid", memory_count: 3 },
    }));

    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      token: "t",
    });
    const result = await client.recall("hello", "session-abc");
    expect(result.context).toBe("recalled-content");
    expect(stub.captured[0].method).toBe("POST");
    expect(stub.captured[0].path).toBe("/recall");
    expect(JSON.parse(stub.captured[0].body)).toEqual({
      query: "hello",
      session_key: "session-abc",
    });
  });

  it("recall returns empty context on error (silent failure)", async () => {
    stub = await startStubServer(() => ({ status: 500, body: { error: "x" } }));
    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      token: "t",
    });
    const result = await client.recall("hello", "k");
    expect(result.context).toBe("");
  });

  it("captureTurn POSTs the expected payload", async () => {
    stub = await startStubServer(() => ({
      status: 200,
      body: { l0_recorded: 1, scheduler_notified: true },
    }));

    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      token: "t",
    });
    await client.captureTurn({
      user_content: "u",
      assistant_content: "a",
      session_key: "k",
      session_id: "s",
    });
    expect(stub.captured[0].path).toBe("/capture");
    expect(JSON.parse(stub.captured[0].body)).toEqual({
      user_content: "u",
      assistant_content: "a",
      session_key: "k",
      session_id: "s",
    });
  });

  it("searchMemories POSTs query, returns results text", async () => {
    stub = await startStubServer(() => ({
      status: 200,
      body: { results: "memory-text", total: 5, strategy: "hybrid" },
    }));

    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      token: "t",
    });
    const res = await client.searchMemories("query");
    expect(res.results).toBe("memory-text");
    expect(res.total).toBe(5);
  });

  it("searchConversations POSTs to /search/conversations", async () => {
    stub = await startStubServer(() => ({
      status: 200,
      body: { results: "conv-text", total: 2 },
    }));

    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      token: "t",
    });
    const res = await client.searchConversations("q");
    expect(res.results).toBe("conv-text");
    expect(stub.captured[0].path).toBe("/search/conversations");
  });

  it("times out long-running requests", async () => {
    const hangServer = http.createServer((_req, _res) => {});
    await new Promise<void>((r) => hangServer.listen(0, "127.0.0.1", () => r()));
    const port = (hangServer.address() as { port: number }).port;

    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "t",
      timeoutMs: 100,
    });
    const result = await client.recall("q", "k");
    expect(result.context).toBe("");
    hangServer.close();
  });
});
