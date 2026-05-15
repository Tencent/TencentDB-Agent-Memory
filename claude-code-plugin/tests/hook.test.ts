import { describe, it, expect, vi } from "vitest";
import { handleHook } from "../lib/hook.js";
import type { GatewayClient, RecallResult } from "../lib/gateway-client.js";

function makeFakeClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    health: vi.fn(async () => true),
    recall: vi.fn(async (): Promise<RecallResult> => ({ context: "recalled" })),
    captureTurn: vi.fn(async () => ({ l0_recorded: 1, scheduler_notified: true })),
    searchMemories: vi.fn(async () => ({ results: "m", total: 1 })),
    searchConversations: vi.fn(async () => ({ results: "c", total: 1 })),
    sessionEnd: vi.fn(async () => {}),
    ...overrides,
  } as unknown as GatewayClient;
}

describe("handleHook: user-prompt-submit", () => {
  it("emits hookSpecificOutput with additionalContext from /recall", async () => {
    const client = makeFakeClient();
    const stdin = JSON.stringify({
      session_id: "s1",
      cwd: "/tmp/proj",
      prompt: "what did we do?",
    });
    const out = await handleHook("user-prompt-submit", { stdin, client });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toBe("recalled");
  });

  it("truncates additionalContext over 10000 chars", async () => {
    const big = "x".repeat(20_000);
    const client = makeFakeClient({
      recall: vi.fn(async () => ({ context: big })),
    } as Partial<GatewayClient>);
    const stdin = JSON.stringify({ session_id: "s", cwd: "/tmp/p", prompt: "q" });
    const out = await handleHook("user-prompt-submit", { stdin, client });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(10_000);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("truncated");
  });

  it("emits empty string when all fallbacks return nothing (no TDAI_DATA_DIR)", async () => {
    const orig = process.env.TDAI_DATA_DIR;
    delete process.env.TDAI_DATA_DIR;
    try {
      const client = makeFakeClient({
        recall: vi.fn(async () => ({ context: "" })),
        searchConversations: vi.fn(async () => ({ results: "", total: 0 })),
      } as Partial<GatewayClient>);
      const stdin = JSON.stringify({ session_id: "s", cwd: "/tmp/p", prompt: "q" });
      const out = await handleHook("user-prompt-submit", { stdin, client });
      expect(out).toBe("");
    } finally {
      if (orig !== undefined) process.env.TDAI_DATA_DIR = orig;
    }
  });

  it("falls back to L0 jsonl direct search when daemon search returns nothing", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = path.join(os.tmpdir(), `tdai-hook-test-${Date.now()}`);
    const convDir = path.join(tmpDir, "conversations");
    await fs.mkdir(convDir, { recursive: true });

    const sessionKey = "abc123";
    const records = [
      JSON.stringify({ sessionKey, role: "user", content: "我用 Go 写 Kubernetes operator", recordedAt: "2026-05-15T06:00:00Z" }),
      JSON.stringify({ sessionKey, role: "assistant", content: "K8s operator 用 Go 是主流", recordedAt: "2026-05-15T06:00:01Z" }),
      JSON.stringify({ sessionKey: "other", role: "user", content: "unrelated stuff", recordedAt: "2026-05-15T06:00:02Z" }),
    ];
    await fs.writeFile(path.join(convDir, "2026-05-15.jsonl"), records.join("\n"));

    const orig = process.env.TDAI_DATA_DIR;
    process.env.TDAI_DATA_DIR = tmpDir;
    try {
      const client = makeFakeClient({
        recall: vi.fn(async () => ({ context: "" })),
        searchConversations: vi.fn(async () => ({ results: "", total: 0 })),
      } as Partial<GatewayClient>);
      // sessionKey in getSessionKey("/tmp/p") won't match "abc123", so we
      // need cwd that hashes to "abc123" — easier: just mock getSessionKey.
      // Instead, directly use a prompt that matches and set cwd so sessionKey
      // matches the records. We'll use TDAI_SESSION_KEY override.
      const origSK = process.env.TDAI_SESSION_KEY;
      process.env.TDAI_SESSION_KEY = sessionKey;
      try {
        const stdin = JSON.stringify({ session_id: "s", cwd: "/tmp/p", prompt: "K8s operator" });
        const out = await handleHook("user-prompt-submit", { stdin, client });
        expect(out).not.toBe("");
        const parsed = JSON.parse(out);
        expect(parsed.hookSpecificOutput.additionalContext).toContain("Past conversations");
        expect(parsed.hookSpecificOutput.additionalContext).toContain("Kubernetes operator");
        // "unrelated stuff" from other session should NOT appear
        expect(parsed.hookSpecificOutput.additionalContext).not.toContain("unrelated");
      } finally {
        if (origSK !== undefined) process.env.TDAI_SESSION_KEY = origSK;
        else delete process.env.TDAI_SESSION_KEY;
      }
    } finally {
      if (orig !== undefined) process.env.TDAI_DATA_DIR = orig;
      else delete process.env.TDAI_DATA_DIR;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to L0 conversation search when /recall returns empty context", async () => {
    const searchConversations = vi.fn(async () => ({
      results: "Found 1 matching message(s):\n---\n**[user]** ...",
      total: 1,
    }));
    const client = makeFakeClient({
      recall: vi.fn(async () => ({ context: "" })),
      searchConversations,
    } as Partial<GatewayClient>);
    const stdin = JSON.stringify({ session_id: "s", cwd: "/tmp/p", prompt: "k8s operator" });
    const out = await handleHook("user-prompt-submit", { stdin, client });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Past conversations");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Found 1 matching");
    // L0 fallback should be scoped to the current project (sessionKey).
    const call = searchConversations.mock.calls[0];
    expect(call[1]?.sessionKey).toBeTruthy();
    expect(call[1]?.limit).toBe(3);
  });

  it("skips L0 fallback when /recall already returns context", async () => {
    const searchConversations = vi.fn(async () => ({ results: "should-not-be-called", total: 1 }));
    const client = makeFakeClient({
      recall: vi.fn(async () => ({ context: "primary-recall" })),
      searchConversations,
    } as Partial<GatewayClient>);
    const stdin = JSON.stringify({ session_id: "s", cwd: "/tmp/p", prompt: "q" });
    const out = await handleHook("user-prompt-submit", { stdin, client });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.additionalContext).toBe("primary-recall");
    expect(searchConversations).not.toHaveBeenCalled();
  });
});

describe("handleHook: stop", () => {
  it("exits silently when stop_hook_active is true", async () => {
    const captureTurn = vi.fn();
    const client = makeFakeClient({
      captureTurn,
    } as Partial<GatewayClient>);
    const stdin = JSON.stringify({
      session_id: "s",
      transcript_path: "/tmp/t.jsonl",
      stop_hook_active: true,
    });
    const out = await handleHook("stop", { stdin, client });
    expect(out).toBe("");
    expect(captureTurn).not.toHaveBeenCalled();
  });

  it("calls captureTurn when stop_hook_active is false", async () => {
    const captureTurn = vi.fn(async () => null);
    const client = makeFakeClient({
      captureTurn,
    } as Partial<GatewayClient>);
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = path.join(os.tmpdir(), `tx-${Date.now()}.jsonl`);
    await fs.writeFile(
      tmp,
      [
        '{"type":"user","message":{"role":"user","content":"q"},"uuid":"u"}',
        '{"type":"assistant","message":{"role":"assistant","content":"a"},"uuid":"a"}',
      ].join("\n"),
    );
    try {
      const stdin = JSON.stringify({
        session_id: "s",
        transcript_path: tmp,
        cwd: "/tmp/proj",
        stop_hook_active: false,
      });
      await handleHook("stop", { stdin, client });
      expect(captureTurn).toHaveBeenCalledOnce();
      const call = captureTurn.mock.calls[0][0];
      expect(call.user_content).toBe("q");
      expect(call.assistant_content).toBe("a");
    } finally {
      await fs.unlink(tmp);
    }
  });
});

describe("handleHook: post-tool-use", () => {
  it("fire-and-forget — does not throw on success", async () => {
    const client = makeFakeClient();
    const stdin = JSON.stringify({
      session_id: "s",
      tool_name: "Read",
      tool_use_id: "t1",
    });
    await expect(
      handleHook("post-tool-use", { stdin, client }),
    ).resolves.not.toThrow();
  });
});

describe("handleHook: session-start", () => {
  it("invokes health probe, succeeds silently", async () => {
    const client = makeFakeClient();
    const stdin = JSON.stringify({ session_id: "s", cwd: "/tmp/p", source: "startup" });
    await expect(
      handleHook("session-start", { stdin, client }),
    ).resolves.not.toThrow();
  });
});

describe("handleHook: search (slash command)", () => {
  it("returns formatted memory search output", async () => {
    const client = makeFakeClient({
      searchMemories: vi.fn(async () => ({ results: "MEMORY_RESULTS", total: 3 })),
    } as Partial<GatewayClient>);
    const out = await handleHook("search", { stdin: "", client, args: ["my", "query"] });
    expect(out).toContain("MEMORY_RESULTS");
  });
});

describe("handleHook: invalid event", () => {
  it("returns empty string on unknown event", async () => {
    const client = makeFakeClient();
    const out = await handleHook("nonsense" as never, {
      stdin: "{}",
      client,
    });
    expect(out).toBe("");
  });
});
