/**
 * memory-tencentdb-client — OpenClaw 记忆插件（客户端接入版）
 *
 * 通过 @tencentdb-agent-memory/memory-sdk-ts 连接远端 memory server，
 * 提供四层记忆的自动捕获、召回和工具调用能力。
 *
 * 本插件不包含任何数据处理逻辑（无 VDB/Embedding/Pipeline），
 * 所有操作委托给远端 server。
 */

import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts";
import { performRecall } from "./src/hooks/recall.js";
import { performCapture } from "./src/hooks/capture.js";
import { handleMemorySearch } from "./src/tools/memory-search.js";
import { handleConversationSearch } from "./src/tools/conversation-search.js";
import { handleReadCos } from "./src/tools/read-cos.js";

const TAG = "[memory-client]";

// ── Config types (matches openclaw.plugin.json configSchema) ──────────
interface ServerConfig {
  url?: string;
  apiKey?: string;
  instanceId?: string;
}
interface RecallConfig {
  maxResults?: number;
  includePersona?: boolean;
  includeSceneNav?: boolean;
}
interface CaptureConfig {
  enabled?: boolean;
}
interface PluginConfig {
  server?: ServerConfig;
  recall?: RecallConfig;
  capture?: CaptureConfig;
}

// Matches OpenClaw plugin register() signature: export default function register(api)
export default function register(api: any) {
  // ── Read config (nested objects per configSchema) ──────────────────
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  const server = cfg.server ?? {};
  const recall = cfg.recall ?? {};
  const capture = cfg.capture ?? {};

  const serverUrl = server.url || "http://127.0.0.1:8420";
  const apiKey = server.apiKey || "sk-xxxx";
  const instanceId = server.instanceId || "default";
  const recallMaxResults = recall.maxResults ?? 5;
  const includePersona = recall.includePersona !== false;
  const includeSceneNav = recall.includeSceneNav !== false;
  const captureEnabled = capture.enabled !== false;

  // ── Initialize SDK ──
  // NOTE: pass config (not a raw Transport) so client.readFile can lazily
  // build its internal MemoryFileReader for STS-signed reads.
  const client = new MemoryClient({
    endpoint: serverUrl,
    apiKey,
    serviceId: instanceId,
  });

  api.logger.info?.(
    `${TAG} Initialized: server=${serverUrl}, instance=${instanceId}, ` +
    `recall(persona=${includePersona},sceneNav=${includeSceneNav},max=${recallMaxResults}), ` +
    `capture=${captureEnabled}`,
  );

  // ── Register Tools (same pattern as extensions/memory-tencentdb/index.ts) ──

  api.registerTool(
    {
      name: "tdai_memory_search",
      label: "Memory Search",
      description:
        "Search structured memories (L1). Returns relevant memory fragments about " +
        "user preferences, past events, rules, and facts.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query text (natural language)." },
          limit: { type: "number", description: "Max results to return (default: 5)." },
          type: { type: "string", description: "Filter by memory type." },
        },
        required: ["query"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        return handleMemorySearch(client, params as any, api.logger);
      },
    },
    { name: "tdai_memory_search" },
  );

  api.registerTool(
    {
      name: "tdai_conversation_search",
      label: "Conversation Search",
      description:
        "Search raw conversation history (L0). Returns original messages with timestamps.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query text." },
          limit: { type: "number", description: "Max results (default: 5)." },
          session_key: { type: "string", description: "Filter by session ID." },
        },
        required: ["query"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        return handleConversationSearch(client, params as any, api.logger);
      },
    },
    { name: "tdai_conversation_search" },
  );

  api.registerTool(
    {
      name: "tdai_read_cos",
      label: "Read COS File",
      description:
        "Read a file from cloud storage. Use paths from Scene Navigation " +
        "(e.g. 'scene_blocks/xxx.md') or 'persona.md'.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative key)." },
        },
        required: ["path"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        return handleReadCos(client, params as any, api.logger);
      },
    },
    { name: "tdai_read_cos" },
  );

  // ── Register Hooks (api.on pattern, same as memory-tencentdb) ──

  // Per-session caches:
  //   - pendingOriginalPrompts: clean user prompt + messageCount captured at
  //     before_prompt_build, used at agent_end to (a) replace polluted user
  //     message and (b) position-slice this turn's new messages.
  //   - sessionCursors: max timestamp of last captured batch — used as a
  //     fallback when the position slice cannot be determined.
  const pendingOriginalPrompts = new Map<string, { text: string; messageCount: number }>();
  const sessionCursors = new Map<string, number>();

  api.on("before_prompt_build", async (event: any, ctx: any) => {
    const sessionKey = ctx?.sessionKey;
    if (!sessionKey) return;

    const userText = event?.prompt;
    if (!userText) return;

    // Cache original prompt for agent_end (only if capture is enabled — it is
    // the only consumer; recall doesn't need this data).
    if (captureEnabled) {
      const messageCount = Array.isArray(event?.messages) ? event.messages.length : 0;
      pendingOriginalPrompts.set(sessionKey, { text: userText, messageCount });
    }

    try {
      const result = await performRecall(client, {
        query: userText,
        maxResults: recallMaxResults,
        includePersona,
        includeSceneNav,
      }, api.logger);

      // OpenClaw consumes the *return value* of before_prompt_build,
      // not mutations on the event object. Map our RecallResult to the
      // PluginHookBeforePromptBuildResult shape.
      const out: { prependContext?: string; appendSystemContext?: string } = {};
      if (result.prependContext) out.prependContext = result.prependContext;
      if (result.appendSystemContext) out.appendSystemContext = result.appendSystemContext;
      return out;
    } catch (err) {
      api.logger.warn(`${TAG} [recall] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  if (captureEnabled) {
    api.logger.info?.(`${TAG} Registering agent_end hook for auto-capture`);
    api.on("agent_end", async (event: any, ctx: any) => {
      const startMs = Date.now();
      const sessionKey = ctx?.sessionKey;
      const messages = (event?.messages ?? []) as unknown[];

      api.logger.debug?.(
        `${TAG} [agent_end] hook triggered: success=${event?.success}, ` +
        `messages=${messages.length}, sessionKey=${sessionKey ?? "(none)"}`,
      );

      // Skip on agent failure — partial / errored turns shouldn't pollute L0.
      if (event?.success === false) {
        api.logger.info(`${TAG} [agent_end] agent did not succeed, skip capture`);
        return;
      }

      if (!sessionKey) {
        api.logger.warn(`${TAG} [agent_end] no sessionKey in ctx, skip capture`);
        return;
      }
      if (messages.length === 0) {
        api.logger.debug?.(`${TAG} [agent_end] event.messages is empty, skip capture`);
        return;
      }

      const cached = pendingOriginalPrompts.get(sessionKey);
      // Don't delete on read — keep until we successfully send (in case of retry),
      // or let it be overwritten on next before_prompt_build.

      try {
        const result = await performCapture(
          client,
          {
            sessionKey,
            sessionId: ctx?.sessionId,
            rawMessages: messages,
            originalUserText: cached?.text,
            originalUserMessageCount: cached?.messageCount,
            afterTimestamp: sessionCursors.get(sessionKey),
          },
          api.logger,
        );

        if (result.maxTimestamp) {
          sessionCursors.set(sessionKey, result.maxTimestamp);
        }
        // Cached prompt has been used — clear it so a stale value doesn't
        // bleed into the next turn (e.g. after agent restart).
        pendingOriginalPrompts.delete(sessionKey);

        const elapsed = Date.now() - startMs;
        api.logger.info(
          `${TAG} [agent_end] capture done in ${elapsed}ms ` +
          `(captured=${result.capturedCount}, serverTotal=${result.serverTotalCount ?? "?"})`,
        );
      } catch (err) {
        const elapsed = Date.now() - startMs;
        api.logger.warn(
          `${TAG} [capture] Failed after ${elapsed}ms: ` +
          (err instanceof Error ? err.message : String(err)),
        );
      }
    });
  } else {
    api.logger.info?.(`${TAG} capture disabled by config`);
  }
}
