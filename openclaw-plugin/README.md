# OpenClaw Adapter for TencentDB Agent Memory

[简体中文](./README_CN.md) · English

This directory is a reference implementation for integrating an Agent framework with TencentDB Agent Memory v2 API. It is an OpenClaw client plugin: it does not run extraction, indexing, scene generation, or persona generation itself. Instead, it connects to an already-running Memory Gateway and uses the TypeScript SDK to capture conversations, recall memories, and expose memory tools to the Agent.

For standalone local usage, the recommended Memory Gateway endpoint is `http://127.0.0.1:8420`. The default local convention is `apiKey = "local"` and `serviceId = "default"`. If your Gateway enables `TDAI_GATEWAY_API_KEY`, use the same value as `server.apiKey`.

## Architecture

```text
OpenClaw runtime
  └─ memory-tencentdb-client plugin
       ├─ hooks/capture.ts             agent_end -> addConversation (L0)
       ├─ hooks/recall.ts              before_prompt_build -> search + prompt injection
       ├─ tools/memory-search.ts       tdai_memory_search -> searchAtomic (L1)
       ├─ tools/conversation-search.ts tdai_conversation_search -> searchConversation (L0)
       └─ tools/read-cos.ts            tdai_read_cos -> read L2/L3 artifacts
            │
            ▼
       @tencentdb-agent-memory/memory-sdk-ts
            │ HTTP v2 API
            ▼
       TencentDB Agent Memory Gateway (:8420 standalone, or remote service)
```

## Quick Start

Recommended: run the installer from the repository root:

```bash
bash scripts/install-openclaw-plugin-v2.sh
```

The script checks/installs the OpenClaw CLI, installs plugin dependencies, builds the plugin, and installs the current `openclaw-plugin` directory into OpenClaw through `openclaw plugins install -l`. By default it also updates `~/.openclaw/openclaw.json`: it sets `plugins.slots.memory = "memory-tencentdb-client"`, enables the plugin, and writes the standalone defaults for `server`, `recall`, and `capture`. The script auto-detects the OpenClaw version: on **2026.4.24+** it also writes `hooks.allowPromptInjection` / `hooks.allowConversationAccess` (required by non-bundled plugins to enable conversation capture); on **older versions** these fields are **omitted**, because gateways before 2026.4.24 use a strict zod schema that refuses to start with these fields present.

You can override defaults with environment variables: `OPENCLAW_CONFIG_FILE`, `TDAI_MEMORY_ENDPOINT`, `TDAI_MEMORY_API_KEY`, `TDAI_MEMORY_INSTANCE_ID`, `TDAI_MEMORY_RECALL_MAX_RESULTS`, and `TDAI_MEMORY_CAPTURE_ENABLED`. Set `WRITE_OPENCLAW_CONFIG=0` if you only want to install the plugin without modifying OpenClaw config.

For manual installation, follow the steps below.

### 1. Install OpenClaw

If OpenClaw is not installed yet, install the OpenClaw CLI first:

```bash
curl -fsSL https://get.openclaw.dev | bash
```

Verify that the command is available:

```bash
openclaw --version
```

### 2. Install dependencies

```bash
cd openclaw-plugin
npm install
```

The plugin depends on `@tencentdb-agent-memory/memory-sdk-ts`, the TypeScript SDK for the v2 API.

### 3. Build

```bash
npm run build
```

### 4. Install the plugin into OpenClaw

For local source development, install the current directory as a linked plugin:

```bash
openclaw plugins install -l .
```

### 5. Configure the plugin

If you use the `agentmemory/openclaw-memory` container image, the entrypoint already generates this configuration for you, so you usually do not need to edit it manually.

If you use `scripts/install-openclaw-plugin-v2.sh`, the script writes this configuration by default as well, and version-gates the `hooks.*` policy fields automatically. You only need to edit the OpenClaw config yourself when running with `WRITE_OPENCLAW_CONFIG=0` or when installing manually.

> ⚠️ **Important — `hooks.*` is version-gated.**
> The `hooks.allowPromptInjection` / `hooks.allowConversationAccess` fields were added to the gateway schema in **OpenClaw `2026.4.24`**. Earlier versions (including `2026.4.23`) use a strict zod schema and will **refuse to start** if these fields are present. **Pick the example that matches your installed OpenClaw version.** Run `openclaw --version` to check.

**Example A — OpenClaw `>= 2026.4.24` (recommended):**

```jsonc
{
  "plugins": {
    "slots": {
      "memory": "memory-tencentdb-client"
    },
    "entries": {
      "memory-tencentdb-client": {
        "enabled": true,
        // hooks.* is REQUIRED on >= 2026.4.24 for non-bundled plugins.
        // Without allowConversationAccess=true, L0 capture is silently blocked.
        "hooks": {
          "allowPromptInjection": true,
          "allowConversationAccess": true
        },
        "config": {
          "server": {
            "url": "http://127.0.0.1:8420",
            "apiKey": "local",
            "instanceId": "default"
          },
          "recall": {
            "maxResults": 5,
            "includePersona": true,
            "includeSceneNav": true
          },
          "capture": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

**Example B — OpenClaw `< 2026.4.24` (e.g. `2026.4.23`): omit the `hooks` block entirely.**

```jsonc
{
  "plugins": {
    "slots": {
      "memory": "memory-tencentdb-client"
    },
    "entries": {
      "memory-tencentdb-client": {
        "enabled": true,
        // ⚠️ DO NOT add a "hooks" block here. The strict schema in 2026.4.23 and
        // earlier rejects allowPromptInjection / allowConversationAccess and the
        // gateway will fail to start. Upgrade OpenClaw to use those fields.
        "config": {
          "server": {
            "url": "http://127.0.0.1:8420",
            "apiKey": "local",
            "instanceId": "default"
          },
          "recall": {
            "maxResults": 5,
            "includePersona": true,
            "includeSceneNav": true
          },
          "capture": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

If the Gateway is protected by `TDAI_GATEWAY_API_KEY`, set `server.apiKey` to that value. `server.instanceId` is sent as `x-tdai-service-id`; standalone mode uses `default`.

`hooks.allowPromptInjection` allows `before_prompt_build` to inject recalled context. `hooks.allowConversationAccess` allows `agent_end` to read the raw conversation and write L0. **Version compatibility:**
- **OpenClaw `>= 2026.4.24`** — these fields are recognised by the gateway schema. `allowConversationAccess` must be set to `true` for non-bundled plugins (otherwise conversation hooks are silently blocked and L0 capture stops working). `allowPromptInjection` defaults to allowed when unset; we still write `true` to lock the intent.
- **OpenClaw `< 2026.4.24`** (including 4.23 and earlier) — the gateway uses a strict zod schema that **rejects** these fields. **Do not include the `hooks.*` block at all**, otherwise the gateway will fail to start. The installer script auto-detects the version and skips the block on older hosts.

### 6. Enable the plugin in OpenClaw

The plugin manifest ID is `memory-tencentdb-client`. The container image already wires it as the memory slot. If you install it manually, make sure OpenClaw loads the plugin and selects it for the memory slot. After changing the config, restart the Gateway:

```bash
openclaw gateway restart
```

## Adapter Responsibilities

| Area | Implementation | Description |
|---|---|---|
| Capture | `src/hooks/capture.ts` | Writes completed turns to L0 through `addConversation()` |
| Recall | `src/hooks/recall.ts` | Searches memories before prompt construction and injects concise context |
| L1 tool | `src/tools/memory-search.ts` | Lets the Agent actively search structured memories |
| L0 tool | `src/tools/conversation-search.ts` | Lets the Agent search raw conversation history |
| L2/L3 read tool | `src/tools/read-cos.ts` | Lets the Agent read scene/core artifacts when needed |

## Configuration

| Field | Default | Description |
|---|---|---|
| `server.url` | `http://127.0.0.1:8420` | Memory Gateway URL |
| `server.apiKey` | `""` | Bearer token sent by the SDK. Use `local` for default standalone mode. |
| `server.instanceId` | `default` | Memory space ID, sent as `x-tdai-service-id` |
| `recall.maxResults` | `5` | Max L1 memories injected per turn |
| `recall.includePersona` | `true` | Whether to include L3 core/profile context |
| `recall.includeSceneNav` | `true` | Whether to include L2 scene navigation |
| `capture.enabled` | `true` | Whether to auto-capture completed turns |
| `hooks.allowPromptInjection` | `true` | Allows prompt-build context injection. Defaults to enabled when unset; we write `true` explicitly to lock the intent. **Only write this field on OpenClaw `>= 2026.4.24`** — older gateways reject it with a strict schema. |
| `hooks.allowConversationAccess` | `true` | Allows `agent_end` / `llm_input` / `llm_output` to read raw conversation content for L0 writes. **Required (`true`) for non-bundled plugins** — without it, conversation hooks are silently blocked at registration and L0 capture stops working. **Only write this field on OpenClaw `>= 2026.4.24`** — older gateways reject it with a strict schema. |

## Files

```text
openclaw-plugin/
├── openclaw.plugin.json       # plugin manifest
├── package.json               # dependencies and build script
├── index.ts                   # OpenClaw entrypoint
├── src/hooks/capture.ts       # L0 capture hook
├── src/hooks/recall.ts        # recall hook
├── src/tools/                 # Agent-callable tools
└── src/format.ts              # prompt formatting helpers
```

## Using This as an Adapter Template

When adapting another Agent framework, copy the same pattern:

1. Capture completed user/assistant turns and call `addConversation()`.
2. Before the next prompt, call `searchAtomic()`, `readCore()`, and optionally `listScenarios()`.
3. Inject only concise, labeled memory context into the Agent prompt.
4. Expose active tools for L1 search, L0 conversation search, and L2 scene read.
5. Keep the adapter stateless; the Memory Gateway owns storage and asynchronous L1/L2/L3 processing.

## Notes

This plugin is a client-side adapter only. It should not start a Memory Gateway subprocess and should not implement memory extraction logic locally. For the standalone Gateway startup and SDK examples, see the root README.
