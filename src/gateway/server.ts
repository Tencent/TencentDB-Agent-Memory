/**
 * TDAI Gateway — HTTP server for the Hermes sidecar.
 *
 * Exposes TDAI Core capabilities as HTTP endpoints:
 *   GET  /                    — Service metadata for browser/local preview probes
 *   GET  /health              — Health check
 *   POST /recall              — Memory recall (prefetch)
 *   POST /capture             — Conversation capture (sync_turn)
 *   POST /search/memories     — L1 memory search
 *   POST /search/conversations — L0 conversation search
 *   POST /session/end         — Session end + flush
 *   POST /seed               — Batch seed historical conversations (L0 → L1, optionally L2/L3)
 *
 * Built with Node.js native `http` module — no Express/Fastify dependency.
 * Designed to run as a managed sidecar alongside Hermes.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { URL } from "node:url";
import { TdaiCore } from "../core/tdai-core.js";
import { StandaloneHostAdapter } from "../adapters/standalone/host-adapter.js";
import { loadGatewayConfig } from "./config.js";
import type { GatewayConfig } from "./config.js";
import { initDataDirectories } from "../utils/pipeline-factory.js";
import { SessionFilter } from "../utils/session-filter.js";
import type {
  RootResponse,
  HealthResponse,
  RecallRequest,
  RecallResponse,
  CaptureRequest,
  CaptureResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  ConversationSearchRequest,
  ConversationSearchResponse,
  SessionEndRequest,
  SessionEndResponse,
  SeedRequest,
  SeedResponse,
  GatewayErrorResponse,
} from "./types.js";
import type { Logger } from "../core/types.js";
import { validateAndNormalizeRaw, fillTimestamps, SeedValidationError } from "../core/seed/input.js";
import { executeSeed } from "../core/seed/seed-runtime.js";
import type { SeedProgress } from "../core/seed/types.js";

const TAG = "[tdai-gateway]";
const VERSION = "0.1.0";

// ============================
// Console logger (for standalone gateway — no OpenClaw logger available)
// ============================

function createConsoleLogger(): Logger {
  return {
    debug: (msg: string) => console.debug(`${TAG} ${msg}`),
    info: (msg: string) => console.info(`${TAG} ${msg}`),
    warn: (msg: string) => console.warn(`${TAG} ${msg}`),
    error: (msg: string) => console.error(`${TAG} ${msg}`),
  };
}

// ============================
// Request body parser
// ============================

async function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(body) as T);
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message } satisfies GatewayErrorResponse);
}

// ============================
// Gateway Server
// ============================

export class TdaiGateway {
  private config: GatewayConfig;
  private logger: Logger;
  private core: TdaiCore;
  private server: http.Server | null = null;
  private startTime = Date.now();

  constructor(configOverrides?: Partial<GatewayConfig>) {
    this.config = loadGatewayConfig(configOverrides);
    this.logger = createConsoleLogger();

    // Create host adapter
    const adapter = new StandaloneHostAdapter({
      dataDir: this.config.data.baseDir,
      llmConfig: this.config.llm,
      logger: this.logger,
      platform: "gateway",
    });

    // Create core
    this.core = new TdaiCore({
      hostAdapter: adapter,
      config: this.config.memory,
      sessionFilter: new SessionFilter(this.config.memory.capture.excludeAgents),
    });
  }

  /**
   * Start the Gateway HTTP server.
   */
  async start(): Promise<void> {
    // Initialize data directories
    initDataDirectories(this.config.data.baseDir);

    // Initialize core
    await this.core.initialize();

    // Create HTTP server
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    const { port, host } = this.config.server;

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        this.startTime = Date.now();
        this.logger.info(`Gateway listening on http://${host}:${port}`);
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  /**
   * Gracefully stop the Gateway.
   */
  async stop(): Promise<void> {
    this.logger.info("Shutting down gateway...");

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }

    await this.core.destroy();
    this.logger.info("Gateway stopped");
  }

  // ============================
  // Request router
  // ============================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method?.toUpperCase() ?? "GET";
    const pathname = url.pathname;

    if (!this.applyCors(req, res)) return;

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!this.authorizeRequest(req, res, method)) return;

    try {
      switch (`${method} ${pathname}`) {
        case "GET /":
          return this.handleRoot(res);
        case "GET /health":
          return this.handleHealth(res);
        case "POST /recall":
          return await this.handleRecall(req, res);
        case "POST /capture":
          return await this.handleCapture(req, res);
        case "POST /search/memories":
          return await this.handleSearchMemories(req, res);
        case "POST /search/conversations":
          return await this.handleSearchConversations(req, res);
        case "POST /session/end":
          return await this.handleSessionEnd(req, res);
        case "POST /seed":
          return await this.handleSeed(req, res);
        default:
          sendError(res, 404, `Not found: ${method} ${pathname}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Request error [${method} ${pathname}]: ${msg}`);
      sendError(res, 500, msg);
    }
  }

  // ============================
  // Route handlers
  // ============================

  private applyCors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    const origin = String(req.headers.origin ?? "");
    if (!origin) return true;
    if (!isAllowedCorsOrigin(origin)) {
      sendError(res, 403, "CORS origin not allowed");
      return false;
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    return true;
  }

  private authorizeRequest(req: http.IncomingMessage, res: http.ServerResponse, method: string): boolean {
    const token = expectedGatewayToken();

    if (!token) {
      if (!isLoopbackHost(this.config.server.host)) {
        sendError(res, 401, "Unauthorized: Gateway token is required for non-loopback routes");
        return false;
      }

      if (method === "GET") {
        return true;
      }

      if (process.env.TDAI_GATEWAY_AUTH_DISABLED === "true") {
        return true;
      }

      res.setHeader("WWW-Authenticate", 'Bearer realm="tdai-gateway"');
      sendError(res, 401, "Unauthorized: Gateway token is required for POST routes; set TDAI_GATEWAY_AUTH_DISABLED=true only for trusted loopback development");
      return false;
    }

    const authorization = String(req.headers.authorization ?? "");
    const match = authorization.match(/^Bearer\s+(\S+)\s*$/i);
    if (!match || !safeTokenEqual(match[1], token)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="tdai-gateway"');
      sendError(res, 401, "Unauthorized");
      return false;
    }
    return true;
  }

  private handleRoot(res: http.ServerResponse): void {
    const response: RootResponse = {
      service: "TencentDB Agent Memory Gateway",
      kind: "api",
      version: VERSION,
      message: "This local service is an API sidecar, not a web UI. Use GET /health for readiness.",
      endpoints: [
        { method: "GET", path: "/health", description: "Gateway readiness and store status" },
        { method: "POST", path: "/recall", description: "Memory recall for a session query" },
        { method: "POST", path: "/capture", description: "Conversation turn capture" },
        { method: "POST", path: "/search/memories", description: "Structured memory search" },
        { method: "POST", path: "/search/conversations", description: "Raw conversation search" },
        { method: "POST", path: "/session/end", description: "Session flush" },
        { method: "POST", path: "/seed", description: "Batch seed historical conversations" },
      ],
    };
    sendJson(res, 200, response);
  }

  private handleHealth(res: http.ServerResponse): void {
    const response: HealthResponse = {
      status: this.core.getVectorStore() ? "ok" : "degraded",
      version: VERSION,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      stores: {
        vectorStore: !!this.core.getVectorStore(),
        embeddingService: !!this.core.getEmbeddingService(),
      },
    };
    sendJson(res, 200, response);
  }

  private async handleRecall(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<RecallRequest>(req);

    if (!body.query || !body.session_key) {
      sendError(res, 400, "Missing required fields: query, session_key");
      return;
    }

    const startMs = Date.now();
    const result = await this.core.handleBeforeRecall(body.query, body.session_key);
    const elapsed = Date.now() - startMs;

    this.logger.info(`Recall completed in ${elapsed}ms: context=${(result.appendSystemContext?.length ?? 0)} chars`);

    const response: RecallResponse = {
      context: result.appendSystemContext ?? "",
      strategy: result.recallStrategy,
      memory_count: result.recalledL1Memories?.length ?? 0,
    };
    sendJson(res, 200, response);
  }

  private async handleCapture(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<CaptureRequest>(req);

    if (!body.user_content || !body.assistant_content || !body.session_key) {
      sendError(res, 400, "Missing required fields: user_content, assistant_content, session_key");
      return;
    }

    const startMs = Date.now();
    const result = await this.core.handleTurnCommitted({
      userText: body.user_content,
      assistantText: body.assistant_content,
      messages: body.messages ?? [
        { role: "user", content: body.user_content },
        { role: "assistant", content: body.assistant_content },
      ],
      sessionKey: body.session_key,
      sessionId: body.session_id,
      startedAt: typeof body.started_at === "number" ? body.started_at : undefined,
    });
    const elapsed = Date.now() - startMs;

    this.logger.info(`Capture completed in ${elapsed}ms: l0=${result.l0RecordedCount}`);

    const response: CaptureResponse = {
      l0_recorded: result.l0RecordedCount,
      scheduler_notified: result.schedulerNotified,
    };
    sendJson(res, 200, response);
  }

  private async handleSearchMemories(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<MemorySearchRequest>(req);

    if (!body.query) {
      sendError(res, 400, "Missing required field: query");
      return;
    }

    const result = await this.core.searchMemories({
      query: body.query,
      limit: body.limit,
      type: body.type,
      scene: body.scene,
      sessionKeyPrefixes: body.session_key_prefixes,
    });

    const response: MemorySearchResponse = {
      results: result.text,
      total: result.total,
      strategy: result.strategy,
    };
    sendJson(res, 200, response);
  }

  private async handleSearchConversations(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<ConversationSearchRequest>(req);

    if (!body.query) {
      sendError(res, 400, "Missing required field: query");
      return;
    }

    const result = await this.core.searchConversations({
      query: body.query,
      limit: body.limit,
      sessionKey: body.session_key,
      sessionKeyPrefixes: body.session_key_prefixes,
    });

    const response: ConversationSearchResponse = {
      results: result.text,
      total: result.total,
    };
    sendJson(res, 200, response);
  }

  private async handleSessionEnd(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<SessionEndRequest>(req);

    if (!body.session_key) {
      sendError(res, 400, "Missing required field: session_key");
      return;
    }

    await this.core.handleSessionEnd(body.session_key);

    const response: SessionEndResponse = { flushed: true };
    sendJson(res, 200, response);
  }

  private async handleSeed(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<SeedRequest>(req);

    if (!body.data) {
      sendError(res, 400, "Missing required field: data");
      return;
    }

    // Validate and normalize input (reuses seed CLI's validation layers 2-6)
    let input;
    try {
      input = validateAndNormalizeRaw(body.data, {
        sessionKey: body.session_key,
        strictRoundRole: body.strict_round_role,
        autoFillTimestamps: body.auto_fill_timestamps ?? true,
      });
    } catch (err) {
      if (err instanceof SeedValidationError) {
        sendJson(res, 400, {
          error: err.message,
          validation_errors: err.errors,
        });
        return;
      }
      throw err;
    }

    this.logger.info(
      `Seed request: ${input.sessions.length} session(s), ` +
      `${input.totalRounds} round(s), ${input.totalMessages} message(s), ` +
      `waitFullPipeline=${body.wait_for_full_pipeline === true}`,
    );

    // Resolve output directory: use gateway's data dir with a timestamped subfolder
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const outputDir = `${this.config.data.baseDir}/seed-${ts}`;

    // Merge config overrides if provided
    // Start with the base memory config + inject llm config from gateway settings
    const baseConfig = this.config.memory as unknown as Record<string, unknown>;
    let pluginConfig: Record<string, unknown> = {
      ...baseConfig,
      llm: {
        enabled: true,
        baseUrl: this.config.llm.baseUrl,
        apiKey: this.config.llm.apiKey,
        model: this.config.llm.model,
        maxTokens: this.config.llm.maxTokens,
        timeoutMs: this.config.llm.timeoutMs,
      },
    };
    if (body.config_override) {
      const blockedOverridePaths = findBlockedConfigOverridePaths(body.config_override);
      if (blockedOverridePaths.length > 0) {
        sendJson(res, 400, {
          error: "config_override contains blocked credential-bearing or network-routing keys",
          blocked_paths: blockedOverridePaths,
        });
        return;
      }

      for (const key of Object.keys(body.config_override)) {
        const baseVal = pluginConfig[key];
        const overVal = body.config_override[key];
        if (baseVal && typeof baseVal === "object" && !Array.isArray(baseVal) &&
            overVal && typeof overVal === "object" && !Array.isArray(overVal)) {
          pluginConfig[key] = { ...(baseVal as Record<string, unknown>), ...(overVal as Record<string, unknown>) };
        } else {
          pluginConfig[key] = overVal;
        }
      }
    }

    // Execute seed pipeline (blocking — this may take minutes for large inputs)
    const summary = await executeSeed(input, {
      outputDir,
      openclawConfig: {},
      pluginConfig,
      waitForFullPipeline: body.wait_for_full_pipeline === true,
      fullPipelineFlushTimeoutMs: typeof body.full_pipeline_timeout_ms === "number"
        ? body.full_pipeline_timeout_ms
        : undefined,
      logger: this.logger as import("../utils/pipeline-factory.js").PipelineLogger,
      onProgress: (progress: SeedProgress) => {
        this.logger.debug?.(
          `Seed progress: [${progress.currentRound}/${progress.totalRounds}] ` +
          `session=${progress.sessionKey} stage=${progress.stage}`,
        );
      },
    });

    this.logger.info(
      `Seed complete: sessions=${summary.sessionsProcessed}, rounds=${summary.roundsProcessed}, ` +
      `l0=${summary.l0RecordedCount}, duration=${(summary.durationMs / 1000).toFixed(1)}s`,
    );

    const response: SeedResponse = {
      sessions_processed: summary.sessionsProcessed,
      rounds_processed: summary.roundsProcessed,
      messages_processed: summary.messagesProcessed,
      l0_recorded: summary.l0RecordedCount,
      full_pipeline_flushed: summary.fullPipelineFlushed,
      duration_ms: summary.durationMs,
      output_dir: summary.outputDir,
    };
    sendJson(res, 200, response);
  }
}

function expectedGatewayToken(): string {
  const direct = process.env.TDAI_GATEWAY_TOKEN?.trim();
  if (direct) return direct;

  const tokenPath = process.env.TDAI_TOKEN_PATH?.trim();
  if (!tokenPath) return "";
  try {
    const stat = fs.statSync(tokenPath);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return "\0";
    if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      return "\0";
    }
    return fs.readFileSync(tokenPath, "utf-8").trim() || "\0";
  } catch {
    return "\0";
  }
}

function isAllowedCorsOrigin(origin: string): boolean {
  const explicit = process.env.TDAI_GATEWAY_CORS_ORIGINS?.trim();
  if (explicit) {
    const allowed = explicit.split(",").map((item) => item.trim()).filter(Boolean);
    if (allowed.includes("*")) return true;
    return allowed.includes(origin);
  }

  try {
    const url = new URL(origin);
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]";
}

function findBlockedConfigOverridePaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const blocked: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const current = prefix ? `${prefix}.${key}` : key;
    if (isBlockedConfigOverridePath(current)) {
      blocked.push(current);
      continue;
    }
    blocked.push(...findBlockedConfigOverridePaths(child, current));
  }
  return blocked;
}

function isBlockedConfigOverridePath(path: string): boolean {
  const parts = path.toLowerCase().split(".");
  const leaf = parts.at(-1) || "";
  if (parts[0] === "tcvdb") return true;
  if (parts[0] === "embedding") return true;
  if (parts[0] === "llm" && ["apikey", "baseurl", "enabled"].includes(leaf)) return true;
  if (parts[0] === "offload" && ["backendurl", "backendapikey", "mode"].includes(leaf)) return true;
  return /(?:apikey|secret|token|password|authorization|credential|baseurl|backendurl|proxyurl)$/.test(leaf);
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

// ============================
// CLI entry point
// ============================

/**
 * Start the gateway from the command line.
 * Usage: node --import tsx src/gateway/server.ts
 */
async function main(): Promise<void> {
  const gateway = new TdaiGateway();

  // Graceful shutdown
  const shutdown = async () => {
    await gateway.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await gateway.start();
}

// Auto-start when run directly
const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  main().catch((err) => {
    console.error("Gateway startup failed:", err);
    process.exit(1);
  });
}
