/**
 * Unified hook entry point. Dispatched by the first CLI arg.
 *
 * Usage from cc plugin hook config:
 *   node ${CLAUDE_PLUGIN_ROOT}/dist/lib/hook.mjs <event-name>
 *
 * Where <event-name> is one of:
 *   session-start | user-prompt-submit | post-tool-use | stop |
 *   search | status | clear-session
 */

import { GatewayClient } from "./gateway-client.js";
import { getSessionKey } from "./session-key.js";
import { readLatestTurn } from "./transcript.js";
import { DaemonManager, readDaemonState } from "./daemon.js";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_INJECT_CHARS = 10_000;

export type HookEvent =
  | "session-start"
  | "user-prompt-submit"
  | "post-tool-use"
  | "stop"
  | "search"
  | "status"
  | "clear-session";

export interface HookInput {
  stdin: string;
  client: GatewayClient;
  args?: string[];
}

export async function handleHook(event: HookEvent, input: HookInput): Promise<string> {
  const data = parseStdin(input.stdin);
  switch (event) {
    case "session-start":
      return handleSessionStart(data, input.client);
    case "user-prompt-submit":
      return handleUserPromptSubmit(data, input.client);
    case "post-tool-use":
      return handlePostToolUse(data, input.client);
    case "stop":
      return handleStop(data, input.client);
    case "search":
      return handleSearch(input.args ?? [], input.client);
    case "status":
      return handleStatus(input.client);
    case "clear-session":
      return handleClearSession(data, input.client);
    default:
      return "";
  }
}

interface HookStdin {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  source?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  stop_hook_active?: boolean;
}

function parseStdin(raw: string): HookStdin {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HookStdin;
  } catch {
    return {};
  }
}

async function handleSessionStart(_data: HookStdin, client: GatewayClient): Promise<string> {
  await client.health();
  return "";
}

async function handleUserPromptSubmit(data: HookStdin, client: GatewayClient): Promise<string> {
  const prompt = data.prompt ?? "";
  const cwd = data.cwd ?? process.cwd();
  if (!prompt) return "";

  const sessionKey = getSessionKey(cwd);
  const result = await client.recall(prompt, sessionKey);
  let context = result.context ?? "";
  if (!context) return "";

  if (context.length > MAX_INJECT_CHARS) {
    context =
      context.slice(0, MAX_INJECT_CHARS - 100) +
      "\n\n[…recall truncated — use /memory-search for full results…]";
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  });
}

async function handlePostToolUse(_data: HookStdin, _client: GatewayClient): Promise<string> {
  // No-op fallback. PostToolUse capture is intentionally deferred to a
  // follow-up PR — see spec §5.3 for the buffer endpoint design. The
  // hooks.json registration was removed so this handler is unreachable
  // by default; it remains here only as a safety net if someone manually
  // re-enables the PostToolUse hook before the follow-up lands.
  return "";
}

async function handleStop(data: HookStdin, client: GatewayClient): Promise<string> {
  if (data.stop_hook_active === true) return "";
  if (!data.transcript_path) return "";

  const turn = await readLatestTurn(data.transcript_path);
  if (!turn) return "";

  const cwd = data.cwd ?? process.cwd();
  const sessionKey = getSessionKey(cwd);

  await client.captureTurn({
    user_content: turn.user,
    assistant_content: turn.assistant,
    session_key: sessionKey,
    session_id: data.session_id,
  });
  return "";
}

async function handleSearch(args: string[], client: GatewayClient): Promise<string> {
  const query = args.join(" ").trim();
  if (!query) return "Usage: /memory-search <query>";
  const result = await client.searchMemories(query, { limit: 10 });
  return result.results || "No memories found.";
}

async function handleStatus(client: GatewayClient): Promise<string> {
  const ok = await client.health();
  return ok ? "TDAI memory daemon: healthy" : "TDAI memory daemon: unreachable";
}

async function handleClearSession(data: HookStdin, client: GatewayClient): Promise<string> {
  const cwd = data.cwd ?? process.cwd();
  const sessionKey = getSessionKey(cwd);
  await client.sessionEnd(sessionKey);
  return `Cleared session buffer for: ${sessionKey}`;
}

// ============================================================================
// CLI entry — only runs when this file is executed directly via `node hook.js`
// ============================================================================

async function main(): Promise<void> {
  const event = (process.argv[2] ?? "") as HookEvent;
  const args = process.argv.slice(3);

  const dataDir = process.env.CLAUDE_PLUGIN_DATA ?? join(process.env.HOME ?? ".", ".tdai-memory");
  const logPath = join(dataDir, "hook.log");

  try {
    const stdin = await readStdin();

    const mgr = new DaemonManager({ dataDir });
    let state = await readDaemonState(dataDir);

    if (event === "session-start" && !state) {
      try {
        state = await mgr.ensureRunning(process.ppid);
      } catch (err) {
        await safeLog(logPath, `session-start: spawn failed: ${(err as Error).message}`);
      }
    }

    if (!state) {
      await safeLog(logPath, `${event}: no daemon, skipped`);
      return;
    }

    const token = await mgr.readToken(state.tokenPath);
    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${state.port}`,
      token,
      timeoutMs: event === "user-prompt-submit" ? 4_000 : 10_000,
    });

    const out = await handleHook(event, { stdin, client, args });
    if (out) process.stdout.write(out);
  } catch (err) {
    await safeLog(logPath, `${event}: ${(err as Error).message}`);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", () => resolve(""));
  });
}

async function safeLog(path: string, msg: string): Promise<void> {
  try {
    await appendFile(path, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // ignore
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch(() => process.exit(0));
}
