# OpenClaw 适配参考：TencentDB Agent Memory

简体中文 · [English](./README.md)

该目录是一个 Agent 框架接入 TencentDB Agent Memory v2 API 的参考实现。它是 OpenClaw 的客户端插件：插件本身不做抽取、索引、场景归纳或画像生成，而是连接一个已经运行的 Memory Gateway，通过 TypeScript SDK 完成对话捕获、记忆召回和工具暴露。

在 standalone 本地模式下，推荐的 Memory Gateway 地址是 `http://127.0.0.1:8420`。默认约定是 `apiKey = "local"`、`serviceId = "default"`。如果 Gateway 显式启用了 `TDAI_GATEWAY_API_KEY`，则 `server.apiKey` 应使用同一个值。

## 架构

```text
OpenClaw runtime
  └─ memory-tencentdb-client plugin
       ├─ hooks/capture.ts             agent_end -> addConversation (L0)
       ├─ hooks/recall.ts              before_prompt_build -> search + prompt 注入
       ├─ tools/memory-search.ts       tdai_memory_search -> searchAtomic (L1)
       ├─ tools/conversation-search.ts tdai_conversation_search -> searchConversation (L0)
       └─ tools/read-cos.ts            tdai_read_cos -> 读取 L2/L3 文件
            │
            ▼
       @tencentdb-agent-memory/memory-sdk-ts
            │ HTTP v2 API
            ▼
       TencentDB Agent Memory Gateway（standalone :8420 或远端服务）
```

## 快速开始

推荐从仓库根目录执行自动安装脚本：

```bash
bash scripts/install-openclaw-plugin-v2.sh
```

脚本会检查/安装 OpenClaw CLI，安装插件依赖，构建插件，并通过 `openclaw plugins install -l` 将当前 `openclaw-plugin` 目录安装到 OpenClaw。默认还会更新 `~/.openclaw/openclaw.json`：设置 `plugins.slots.memory = "memory-tencentdb-client"`，启用插件，写入 standalone 默认的 `server`、`recall`、`capture` 配置。脚本会自动探测 OpenClaw 版本：**2026.4.24+** 会同时写入 `hooks.allowPromptInjection` / `hooks.allowConversationAccess`（non-bundled 插件需要 `allowConversationAccess=true` 才能采集对话）；**更老的版本会自动跳过**这两个字段——因为 2026.4.24 之前的 gateway 使用 strict zod schema，遇到这两个字段会启动失败。

可通过环境变量覆盖默认值：`OPENCLAW_CONFIG_FILE`、`TDAI_MEMORY_ENDPOINT`、`TDAI_MEMORY_API_KEY`、`TDAI_MEMORY_INSTANCE_ID`、`TDAI_MEMORY_RECALL_MAX_RESULTS`、`TDAI_MEMORY_CAPTURE_ENABLED`。如果只想安装插件、不修改 OpenClaw 配置，可设置 `WRITE_OPENCLAW_CONFIG=0`。

如需手动安装，可按下面步骤执行。

### 1. 安装 OpenClaw

如果你还没有安装 OpenClaw，请先安装 OpenClaw CLI：

```bash
curl -fsSL https://get.openclaw.dev | bash
```

确认命令可用：

```bash
openclaw --version
```

### 2. 安装依赖

```bash
cd openclaw-plugin
npm install
```

插件依赖 `@tencentdb-agent-memory/memory-sdk-ts`，也就是 v2 API 的 TypeScript SDK。

### 3. 构建

```bash
npm run build
```

### 4. 安装插件到 OpenClaw

开发或本地源码调试时，推荐以软链方式安装当前目录：

```bash
openclaw plugins install -l .
```

### 5. 配置插件

如果使用 `agentmemory/openclaw-memory` 容器镜像，镜像启动脚本已经自动完成下面这段配置，通常不需要手动修改。

如果使用 `scripts/install-openclaw-plugin-v2.sh`，脚本默认也会自动写入这段配置，并会自动按 OpenClaw 版本对 `hooks.*` 字段做版本门控。只有在 `WRITE_OPENCLAW_CONFIG=0` 或手动安装插件时，才需要自己编辑 OpenClaw 配置文件。

> ⚠️ **重要 —— `hooks.*` 与 OpenClaw 版本强相关。**
> `hooks.allowPromptInjection` / `hooks.allowConversationAccess` 是 **OpenClaw `2026.4.24`** 起才被 gateway schema 接受的字段。更老的版本（含 `2026.4.23`）使用 strict zod schema，**包含这两个字段会让 gateway 启动失败**。请按你本机 `openclaw --version` 显示的版本，**选择对应的示例**复制：

**示例 A —— OpenClaw `>= 2026.4.24`（推荐）：**

```jsonc
{
  "plugins": {
    "slots": {
      "memory": "memory-tencentdb-client"
    },
    "entries": {
      "memory-tencentdb-client": {
        "enabled": true,
        // 2026.4.24+ 上，non-bundled 插件必须显式 hooks.*。
        // 缺少 allowConversationAccess=true 会让 L0 capture 被静默拦截。
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

**示例 B —— OpenClaw `< 2026.4.24`（如 `2026.4.23`）：完全省略 `hooks` 块。**

```jsonc
{
  "plugins": {
    "slots": {
      "memory": "memory-tencentdb-client"
    },
    "entries": {
      "memory-tencentdb-client": {
        "enabled": true,
        // ⚠️ 不要添加 "hooks" 块。2026.4.23 及更早的 strict schema 会拒绝
        // allowPromptInjection / allowConversationAccess，gateway 启动失败。
        // 如需使用这两个字段，请升级 OpenClaw。
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

如果 Gateway 启用了 `TDAI_GATEWAY_API_KEY`，请将 `server.apiKey` 设置成同一个值。`server.instanceId` 会作为 `x-tdai-service-id` 发送；standalone 模式默认使用 `default`。

`hooks.allowPromptInjection` 允许 `before_prompt_build` 注入召回上下文；`hooks.allowConversationAccess` 允许 `agent_end` 读取原始对话并写入 L0。**版本兼容性：**
- **OpenClaw `>= 2026.4.24`** —— 这两个字段才被 gateway schema 识别。non-bundled 插件必须显式 `allowConversationAccess=true`，否则会话钩子在注册阶段被静默拦截、L0 capture 不会落库；`allowPromptInjection` 未设置时默认放行，我们仍写 `true` 以锁定意图。
- **OpenClaw `< 2026.4.24`**（含 4.23 及更早）—— gateway 使用 strict zod schema，**会拒绝**这两个字段。**配置中不要包含 `hooks.*` 块**，否则 gateway 启动失败。安装脚本会自动按版本探测、在老版本上跳过该块。

### 6. 在 OpenClaw 中启用

插件 ID 是 `memory-tencentdb-client`。容器镜像中已经将它接入 memory slot。如果手动安装，请确保 OpenClaw 能加载该插件，并在 memory slot 中选中它。修改配置后可重启 Gateway：

```bash
openclaw gateway restart
```

## 适配职责

| 模块 | 实现文件 | 说明 |
|---|---|---|
| 对话捕获 | `src/hooks/capture.ts` | 对话结束后调用 `addConversation()` 写入 L0 |
| 记忆召回 | `src/hooks/recall.ts` | 构建 prompt 前搜索记忆并注入简洁上下文 |
| L1 工具 | `src/tools/memory-search.ts` | 让 Agent 主动搜索结构化记忆 |
| L0 工具 | `src/tools/conversation-search.ts` | 让 Agent 主动搜索历史对话 |
| L2/L3 读取工具 | `src/tools/read-cos.ts` | 让 Agent 在需要时读取场景或画像文件 |

## 配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `server.url` | `http://127.0.0.1:8420` | Memory Gateway 地址 |
| `server.apiKey` | `""` | SDK 发送的 Bearer token。standalone 默认可用 `local`。 |
| `server.instanceId` | `default` | Memory 空间 ID，通过 `x-tdai-service-id` 发送 |
| `recall.maxResults` | `5` | 每轮最多注入多少条 L1 记忆 |
| `recall.includePersona` | `true` | 是否注入 L3 core/profile 上下文 |
| `recall.includeSceneNav` | `true` | 是否注入 L2 场景导航 |
| `capture.enabled` | `true` | 是否自动捕获完整对话轮次 |
| `hooks.allowPromptInjection` | `true` | 允许插件在 prompt 构建阶段注入召回上下文。未设置时默认放行，我们显式写 `true` 是为了锁定意图。**仅在 OpenClaw `>= 2026.4.24` 时写入此字段**——更老的 gateway 会用 strict schema 拒绝它。 |
| `hooks.allowConversationAccess` | `true` | 允许插件在 `agent_end` / `llm_input` / `llm_output` 读取原始对话用于 L0 写入。**non-bundled 插件必须显式 `true`**——否则会话钩子会在注册阶段被静默拦截，L0 capture 不会落库。**仅在 OpenClaw `>= 2026.4.24` 时写入此字段**——更老的 gateway 会用 strict schema 拒绝它。 |

## 文件结构

```text
openclaw-plugin/
├── openclaw.plugin.json       # 插件清单
├── package.json               # 依赖与构建脚本
├── index.ts                   # OpenClaw 入口
├── src/hooks/capture.ts       # L0 捕获 hook
├── src/hooks/recall.ts        # 召回 hook
├── src/tools/                 # Agent 可调用工具
└── src/format.ts              # prompt 格式化辅助
```

## 作为其它 Agent 的适配模板

如果你要适配其它 Agent 框架，可以复用同样模式：

1. 在一轮用户/助手对话完成后调用 `addConversation()`。
2. 在下一轮 prompt 构建前调用 `searchAtomic()`、`readCore()`，必要时调用 `listScenarios()`。
3. 只向 Agent prompt 注入简洁、带标签的记忆上下文。
4. 暴露 L1 搜索、L0 对话搜索、L2 场景读取等主动工具。
5. Adapter 保持无状态；存储、异步 L1/L2/L3 处理都交给 Memory Gateway。

## 注意

该插件只是客户端 adapter，不应在插件内启动 Memory Gateway 子进程，也不应在本地实现记忆抽取逻辑。standalone Gateway 启动方式与 SDK 示例见根目录 README。
