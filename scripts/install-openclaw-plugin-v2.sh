#!/usr/bin/env bash
set -euo pipefail

log() { printf '[install-openclaw-plugin-v2] %s\n' "$*" >&2; }
fail() { printf '[install-openclaw-plugin-v2][ERROR] %s\n' "$*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="${OPENCLAW_PLUGIN_DIR:-$REPO_ROOT/openclaw-plugin}"
INSTALL_OPENCLAW="${INSTALL_OPENCLAW:-1}"
OPENCLAW_INSTALL_FLAGS="${OPENCLAW_INSTALL_FLAGS:-}"
WRITE_OPENCLAW_CONFIG="${WRITE_OPENCLAW_CONFIG:-1}"
OPENCLAW_CONFIG_FILE="${OPENCLAW_CONFIG_FILE:-$HOME/.openclaw/openclaw.json}"
MEMORY_PLUGIN_ID="memory-tencentdb-client"
TDAI_MEMORY_ENDPOINT="${TDAI_MEMORY_ENDPOINT:-http://127.0.0.1:8420}"
TDAI_MEMORY_API_KEY="${TDAI_MEMORY_API_KEY:-local}"
TDAI_MEMORY_INSTANCE_ID="${TDAI_MEMORY_INSTANCE_ID:-${TDAI_MEMORY_SERVICE_ID:-default}}"
TDAI_MEMORY_RECALL_MAX_RESULTS="${TDAI_MEMORY_RECALL_MAX_RESULTS:-5}"
TDAI_MEMORY_INCLUDE_PERSONA="${TDAI_MEMORY_INCLUDE_PERSONA:-true}"
TDAI_MEMORY_INCLUDE_SCENE_NAV="${TDAI_MEMORY_INCLUDE_SCENE_NAV:-true}"
TDAI_MEMORY_CAPTURE_ENABLED="${TDAI_MEMORY_CAPTURE_ENABLED:-true}"
TDAI_MEMORY_ALLOW_PROMPT_INJECTION="${TDAI_MEMORY_ALLOW_PROMPT_INJECTION:-true}"
TDAI_MEMORY_ALLOW_CONVERSATION_ACCESS="${TDAI_MEMORY_ALLOW_CONVERSATION_ACCESS:-true}"

need_cmd npm
need_cmd node
need_cmd curl

if [[ ! -d "$PLUGIN_DIR" ]]; then
  fail "OpenClaw plugin directory not found: $PLUGIN_DIR"
fi

if ! command -v openclaw >/dev/null 2>&1; then
  if [[ "$INSTALL_OPENCLAW" == "1" ]]; then
    log "OpenClaw CLI not found; installing from https://get.openclaw.dev"
    curl -fsSL https://get.openclaw.dev | bash
    export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"
  else
    fail "OpenClaw CLI not found. Install it first or run with INSTALL_OPENCLAW=1."
  fi
fi

command -v openclaw >/dev/null 2>&1 || fail "OpenClaw CLI still not found after install; please check PATH"
OPENCLAW_VERSION_RAW="$(openclaw --version 2>/dev/null || printf 'unknown')"
log "OpenClaw version: $OPENCLAW_VERSION_RAW"

# Hook policy fields (allowPromptInjection / allowConversationAccess) were
# accepted by the gateway zod schema starting at 2026.4.24 (PR #71221).
# 2026.4.23 and earlier use `.strict()` and will REFUSE to start the gateway
# if these fields are present. We therefore version-gate the config write to
# match `src/utils/ensure-hook-policy.ts::HOOK_POLICY_MIN_VERSION`.
HOOK_POLICY_MIN="2026.4.24"
WRITE_HOOK_POLICY=0
if [[ "$OPENCLAW_VERSION_RAW" =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  v_major="${BASH_REMATCH[1]}"
  v_minor="${BASH_REMATCH[2]}"
  v_patch="${BASH_REMATCH[3]}"
  IFS=. read -r m_major m_minor m_patch <<<"$HOOK_POLICY_MIN"
  if (( v_major > m_major )) \
     || { (( v_major == m_major )) && (( v_minor > m_minor )); } \
     || { (( v_major == m_major )) && (( v_minor == m_minor )) && (( v_patch >= m_patch )); }; then
    WRITE_HOOK_POLICY=1
  fi
fi
if [[ "$WRITE_HOOK_POLICY" == "1" ]]; then
  log "Detected OpenClaw >= $HOOK_POLICY_MIN — will write hooks.allowPromptInjection / allowConversationAccess"
else
  log "Detected OpenClaw < $HOOK_POLICY_MIN (or version unparseable) — will SKIP hooks.* policy fields (older gateway schemas reject them)"
fi

log "Installing plugin dependencies"
(cd "$PLUGIN_DIR" && npm install)

log "Building plugin"
(cd "$PLUGIN_DIR" && npm run build)

log "Installing linked plugin into OpenClaw: $PLUGIN_DIR"
# shellcheck disable=SC2086
openclaw plugins install -l "$PLUGIN_DIR" $OPENCLAW_INSTALL_FLAGS

if [[ "$WRITE_OPENCLAW_CONFIG" == "1" ]]; then
  log "Updating OpenClaw config: $OPENCLAW_CONFIG_FILE"
  mkdir -p "$(dirname "$OPENCLAW_CONFIG_FILE")"
  if [[ -f "$OPENCLAW_CONFIG_FILE" ]]; then
    cp "$OPENCLAW_CONFIG_FILE" "$OPENCLAW_CONFIG_FILE.bak.$(date +%Y%m%d%H%M%S)"
  fi

  OPENCLAW_CONFIG_FILE="$OPENCLAW_CONFIG_FILE" \
  MEMORY_PLUGIN_ID="$MEMORY_PLUGIN_ID" \
  TDAI_MEMORY_ENDPOINT="$TDAI_MEMORY_ENDPOINT" \
  TDAI_MEMORY_API_KEY="$TDAI_MEMORY_API_KEY" \
  TDAI_MEMORY_INSTANCE_ID="$TDAI_MEMORY_INSTANCE_ID" \
  TDAI_MEMORY_RECALL_MAX_RESULTS="$TDAI_MEMORY_RECALL_MAX_RESULTS" \
  TDAI_MEMORY_INCLUDE_PERSONA="$TDAI_MEMORY_INCLUDE_PERSONA" \
  TDAI_MEMORY_INCLUDE_SCENE_NAV="$TDAI_MEMORY_INCLUDE_SCENE_NAV" \
  TDAI_MEMORY_CAPTURE_ENABLED="$TDAI_MEMORY_CAPTURE_ENABLED" \
  TDAI_MEMORY_ALLOW_PROMPT_INJECTION="$TDAI_MEMORY_ALLOW_PROMPT_INJECTION" \
  TDAI_MEMORY_ALLOW_CONVERSATION_ACCESS="$TDAI_MEMORY_ALLOW_CONVERSATION_ACCESS" \
  WRITE_HOOK_POLICY="$WRITE_HOOK_POLICY" \
  node <<'NODE'
const fs = require('node:fs');

const file = process.env.OPENCLAW_CONFIG_FILE;
const pluginId = process.env.MEMORY_PLUGIN_ID;

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

let config = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (raw) config = JSON.parse(raw);
}

config.plugins ??= {};
config.plugins.slots ??= {};
config.plugins.entries ??= {};
config.plugins.slots.memory = pluginId;

const entry = config.plugins.entries[pluginId] ?? {};
entry.enabled = true;
// Hook policy fields (allowPromptInjection / allowConversationAccess) are
// only safe to write on OpenClaw >= 2026.4.24. The shell wrapper sets
// WRITE_HOOK_POLICY=1 after parsing `openclaw --version`; on older gateways
// it stays 0 and we *remove* any stale fields to keep the gateway bootable.
const writeHookPolicy = process.env.WRITE_HOOK_POLICY === '1';
if (writeHookPolicy) {
  entry.hooks ??= {};
  entry.hooks.allowPromptInjection = parseBool(process.env.TDAI_MEMORY_ALLOW_PROMPT_INJECTION, entry.hooks.allowPromptInjection ?? true);
  entry.hooks.allowConversationAccess = parseBool(process.env.TDAI_MEMORY_ALLOW_CONVERSATION_ACCESS, entry.hooks.allowConversationAccess ?? true);
} else if (entry.hooks && (entry.hooks.allowPromptInjection !== undefined || entry.hooks.allowConversationAccess !== undefined)) {
  // Older gateways (zod .strict()) reject these fields; strip them defensively.
  delete entry.hooks.allowPromptInjection;
  delete entry.hooks.allowConversationAccess;
  if (Object.keys(entry.hooks).length === 0) delete entry.hooks;
}
entry.config ??= {};
entry.config.server ??= {};
entry.config.recall ??= {};
entry.config.capture ??= {};

entry.config.server.url = process.env.TDAI_MEMORY_ENDPOINT || entry.config.server.url || 'http://127.0.0.1:8420';
entry.config.server.apiKey = process.env.TDAI_MEMORY_API_KEY || entry.config.server.apiKey || 'local';
entry.config.server.instanceId = process.env.TDAI_MEMORY_INSTANCE_ID || entry.config.server.instanceId || 'default';
entry.config.recall.maxResults = parsePositiveInt(process.env.TDAI_MEMORY_RECALL_MAX_RESULTS, entry.config.recall.maxResults ?? 5);
entry.config.recall.includePersona = parseBool(process.env.TDAI_MEMORY_INCLUDE_PERSONA, entry.config.recall.includePersona ?? true);
entry.config.recall.includeSceneNav = parseBool(process.env.TDAI_MEMORY_INCLUDE_SCENE_NAV, entry.config.recall.includeSceneNav ?? true);
entry.config.capture.enabled = parseBool(process.env.TDAI_MEMORY_CAPTURE_ENABLED, entry.config.capture.enabled ?? true);

config.plugins.entries[pluginId] = entry;
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE
else
  log "Skipping OpenClaw config update because WRITE_OPENCLAW_CONFIG=$WRITE_OPENCLAW_CONFIG"
fi

if [[ "$WRITE_HOOK_POLICY" == "1" ]]; then
  HOOK_SUMMARY="  plugins.entries[\"$MEMORY_PLUGIN_ID\"].hooks.allowPromptInjection = $TDAI_MEMORY_ALLOW_PROMPT_INJECTION
  plugins.entries[\"$MEMORY_PLUGIN_ID\"].hooks.allowConversationAccess = $TDAI_MEMORY_ALLOW_CONVERSATION_ACCESS"
else
  HOOK_SUMMARY="  plugins.entries[\"$MEMORY_PLUGIN_ID\"].hooks.* = (skipped — OpenClaw < $HOOK_POLICY_MIN does not accept these fields)"
fi

cat >&2 <<EOF

[install-openclaw-plugin-v2] Done.
Memory plugin configured:
  plugins.slots.memory = "$MEMORY_PLUGIN_ID"
  plugins.entries["$MEMORY_PLUGIN_ID"].enabled = true
$HOOK_SUMMARY
  server.url = "$TDAI_MEMORY_ENDPOINT"
  server.apiKey = "$TDAI_MEMORY_API_KEY"
  server.instanceId = "$TDAI_MEMORY_INSTANCE_ID"

Next steps:
1. Ensure Memory Gateway is running at $TDAI_MEMORY_ENDPOINT.
2. Restart OpenClaw Gateway if needed:
   openclaw gateway restart
EOF
