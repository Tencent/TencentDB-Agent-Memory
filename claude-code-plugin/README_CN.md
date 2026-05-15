# TencentDB Agent Memory — Coding Agent 插件

为 [Claude Code](https://claude.com/claude-code) 与 [OpenAI Codex CLI](https://developers.openai.com/codex/cli) 提供长期记忆 + 符号化短期记忆，由 [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory) 驱动。

插件携带双 manifest（`.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json`），共享同一份 `hooks/hooks.json` 与 `skills/`。Claude Code（v2026.4+）与 Codex CLI（v0.117+）实现了同一份 hook 协议，因此一套源码同时服务两个宿主。

[English version](./README.md)

## 能给你什么

- **自动召回**：每次提问前，相关过往记忆自动注入到上下文
- **自动捕获**：每轮对话结束后，L0 落盘、L1/L2/L3 后台抽取
- **手动控制**：通过 slash 技能 `/memory-search`、`/memory-status`、`/memory-clear-session`
- **项目级隔离**：默认按 cwd hash 分区，`react-app` 的记忆不会泄漏到 `golang-svc`
- **Bearer Token 鉴权**：本地 daemon 不裸奔，所有请求需带 token

## 安装

### 前置条件

先全局安装 gateway 运行时（提供 `tdai-memory-gateway` 命令）—— 插件通过 `npx tdai-memory-gateway` 启动 daemon：

```bash
npm install -g @tencentdb-agent-memory/memory-tencentdb
```

该 npm 包含真正的 `TdaiGateway`（SQLite + sqlite-vec + LLM pipeline）。插件本身只是一层薄壳，提供 hook、skill 和 sessionKey 等绑定逻辑，不携带任何重型依赖。

### Claude Code

```bash
/plugin install tdai-memory
```

### Codex CLI

```bash
codex plugin marketplace add <marketplace-url>
# 在 TUI 中启用：/plugin → 切换 tdai-memory
```

（一旦发布到 Codex marketplace，将变为一条命令安装。）

---

不需要改 `~/.claude/settings.json` 或 `~/.codex/config.toml`。第一次启动 session 时，插件通过 `npx tdai-memory-gateway` 在 8421–8430 端口拉起 daemon，并生成随机 Bearer token。状态保存在 `${CLAUDE_PLUGIN_DATA}`。

## 配置

插件读取三个可选环境变量：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `TDAI_SESSION_KEY` | `hash(cwd)` | 覆盖项目级记忆分区 |
| `TDAI_GATEWAY_TOKEN` | 自动生成 | daemon ↔ hook IPC 的 Bearer token |
| `TDAI_GATEWAY_COMMAND` | `npx` | 覆盖 daemon 启动命令（高级用法；如 `node /path/to/cli.mjs` 用于本地开发） |

大多数用户都不需要设置任何变量。`TDAI_SESSION_KEY=shared-with-other-project` 是最常用的高级用法。

## 数据位置

- `${CLAUDE_PLUGIN_DATA}/state.json` — daemon PID + 端口
- `${CLAUDE_PLUGIN_DATA}/token` — Bearer token（chmod 600）
- `${CLAUDE_PLUGIN_DATA}/memory-tdai/` — SQLite + sqlite-vec 数据、场景块、画像快照
- `${CLAUDE_PLUGIN_DATA}/hook.log` — hook 排障日志

## 工作原理

```
用户输入  → UserPromptSubmit hook → POST /recall   → cc 注入上下文
cc 回复  → Stop hook              → POST /capture  → L0 + L1/L2/L3 流水线
会话退出 → daemon 检测父 cc 退出   → 优雅关闭
```

所有 hook 都是"失败静默"——日志写 `hook.log`，记忆系统永远不在对话的关键路径上。

## 排障

**`/memory-status` 显示 "unreachable"**：
- 看 `${CLAUDE_PLUGIN_DATA}/hook.log` 最近的错误
- 重启 cc 会话——SessionStart hook 会重新探活并 spawn daemon

**多个 cc 终端开同一个项目**：
- 共享一个 daemon。第一个启动的 cc 拉起它，后续 cc 通过 `state.json` 发现并复用。

**记忆召回不准**：
- 直接跑 `/memory-search <topic>` 看存了什么
- L1/L2/L3 抽取是异步的，新对话需要几分钟才能被召回到

## 安全模型

Daemon 仅监听 `127.0.0.1`，每个请求都需要 Bearer token。Token 在每次 spawn 时新生成，存放在 `${CLAUDE_PLUGIN_DATA}/token`，权限 0600。读不到这个文件的进程读不到你的记忆。

## 源码构建

```bash
pnpm install
pnpm build:cc-plugin
pnpm test:cc-plugin
```

## License

MIT — 见 [LICENSE](../LICENSE)。
