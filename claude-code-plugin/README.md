# TencentDB Agent Memory — Coding Agent Plugin

Long-term + symbolic short-term memory for [Claude Code](https://claude.com/claude-code) and [OpenAI Codex CLI](https://developers.openai.com/codex/cli), powered by [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory).

The plugin ships dual manifests (`.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`) and reuses the same `hooks/hooks.json` and `skills/` — both Claude Code (v2026.4+) and Codex CLI (v0.117+) implement the same hook protocol, so a single source tree serves both hosts.

[中文版](./README_CN.md)

## What this gives you

- **Automatic recall** before every prompt — relevant past memories injected into context
- **Automatic capture** after every turn — L0 conversation written, L1/L2/L3 extracted in the background
- **Manual control** via slash skills: `/memory-search`, `/memory-status`, `/memory-clear-session`
- **Project-level isolation** by default (sessionKey = hash of cwd) — your `react-app` memories don't leak into your `golang-svc` work
- **Bearer-secured local daemon** — no plaintext localhost API

## Installation

### Claude Code

```bash
/plugin install tdai-memory
```

### Codex CLI

```bash
codex plugin marketplace add <marketplace-url>
# then enable in the TUI: /plugin → toggle tdai-memory
```

(Once published to the Codex marketplace, this becomes a one-liner.)

---

No `~/.claude/settings.json` or `~/.codex/config.toml` mutation. The first time a session starts after installation, the plugin spawns a local daemon (the existing TDAI Gateway) on port 8421–8430 with a randomly generated Bearer token. State persists under `${CLAUDE_PLUGIN_DATA}`.

## Configuration

The plugin reads three optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `TDAI_SESSION_KEY` | `hash(cwd)` | Override the per-project memory partition |
| `TDAI_GATEWAY_TOKEN` | auto-generated | Bearer token for daemon ↔ hook IPC |
| `TDAI_GATEWAY_ENTRY` | resolved from plugin | Path to the Gateway entry script |

Most users never need to set any of these. `TDAI_SESSION_KEY=shared-with-other-project` is the most common power-user override.

## Data location

- `${CLAUDE_PLUGIN_DATA}/state.json` — daemon PID + port
- `${CLAUDE_PLUGIN_DATA}/token` — Bearer token (chmod 600)
- `${CLAUDE_PLUGIN_DATA}/memory-tdai/` — SQLite + sqlite-vec database, scene blocks, persona snapshots
- `${CLAUDE_PLUGIN_DATA}/hook.log` — hook diagnostic log

## How it works

```
User prompt → UserPromptSubmit hook → POST /recall → cc injects context
cc replies   → Stop hook            → POST /capture → L0 + L1/L2/L3 pipeline
Session end  → daemon detects parent cc exit → graceful shutdown
```

All hook handlers fail silently (writing to `hook.log`) — memory is never on the critical path of your conversation.

## Troubleshooting

**`/memory-status` says "unreachable"**:
- Check `${CLAUDE_PLUGIN_DATA}/hook.log` for the most recent error
- Restart your cc session — the SessionStart hook re-probes and re-spawns the daemon

**Multiple cc terminals on the same project**:
- All terminals share one daemon. The first to launch spawns it; subsequent terminals discover and reuse it via `state.json`.

**Memory doesn't recall what I expect**:
- Run `/memory-search <topic>` directly to see what's stored
- Note that L1/L2/L3 extraction runs asynchronously — fresh conversations may need a few minutes before they appear in recall

## Security model

The daemon listens only on `127.0.0.1` and requires a Bearer token on every request. The token is generated freshly at each spawn and stored at `${CLAUDE_PLUGIN_DATA}/token` with permission 0600. Any process that cannot read that file cannot read your memories.

## Building from source

```bash
pnpm install
pnpm build:cc-plugin
pnpm test:cc-plugin
```

## License

MIT — see [LICENSE](../LICENSE).
