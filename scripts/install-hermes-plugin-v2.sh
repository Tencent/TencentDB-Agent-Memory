#!/usr/bin/env bash
set -euo pipefail

log() { printf '[install-hermes-plugin-v2] %s\n' "$*" >&2; }
fail() { printf '[install-hermes-plugin-v2][ERROR] %s\n' "$*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }

# Target user/home detection follows the legacy Hermes installer convention:
#   1. INSTALL_AS_USER, 2. SUDO_USER, 3. current user.
USERNAME="${INSTALL_AS_USER:-${SUDO_USER:-$(whoami)}}"
USER_HOME="$(eval echo "~$USERNAME")"

SDK_WHEEL_URL="${SDK_WHEEL_URL:-https://cnb.cool/tencent/cloud/nosql/nosql-utilities/-/commit-assets/download/cc74bd6dbc931727da9ab6907b5ab1a07d7afd9d/tencentdb_agent_memory_sdk_python-0.1.0-py3-none-any.whl}"
SDK_WHEEL_NAME="tencentdb_agent_memory_sdk_python-0.1.0-py3-none-any.whl"
FORCE="${FORCE:-0}"
ALLOW_SYSTEM_PYTHON="${ALLOW_SYSTEM_PYTHON:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROVIDER_SRC="${HERMES_PROVIDER_SRC:-$REPO_ROOT/hermes-plugin/memory/memory_tencentdb_v2}"

HERMES_HOME="${HERMES_HOME:-$USER_HOME/.hermes}"
HERMES_AGENT_DIR="${HERMES_AGENT_DIR:-$HERMES_HOME/hermes-agent}"
HERMES_VENV_DIR="${HERMES_VENV_DIR:-$HERMES_AGENT_DIR/venv}"
HERMES_CONFIG="${HERMES_CONFIG:-$HERMES_HOME/config.yaml}"
HERMES_ENV="${HERMES_ENV:-$HERMES_HOME/.env}"
HERMES_MEMORY_PLUGIN_DIR="${HERMES_MEMORY_PLUGIN_DIR:-$HERMES_AGENT_DIR/plugins/memory}"
PROVIDER_TARGET="$HERMES_MEMORY_PLUGIN_DIR/memory_tencentdb_v2"

# Install the SDK into the Python environment that Hermes actually uses.
# Selection order:
#   1. PYTHON_BIN, if explicitly provided
#   2. HERMES_VENV_DIR/bin/python, if present
#   3. Python interpreter from the installed `hermes` command shebang, if discoverable
#   4. system python3 only when ALLOW_SYSTEM_PYTHON=1
if [[ -n "${PYTHON_BIN:-}" ]]; then
  :
elif [[ -x "$HERMES_VENV_DIR/bin/python" ]]; then
  PYTHON_BIN="$HERMES_VENV_DIR/bin/python"
elif command -v hermes >/dev/null 2>&1; then
  HERMES_BIN="$(command -v hermes)"
  HERMES_SHEBANG="$(head -n 1 "$HERMES_BIN" 2>/dev/null || true)"
  if [[ "$HERMES_SHEBANG" == '#!'*python* ]]; then
    HERMES_SHEBANG="${HERMES_SHEBANG#'#!'}"
    read -r HERMES_SHEBANG_CMD HERMES_SHEBANG_ARG _ <<<"$HERMES_SHEBANG"
    if [[ "$(basename "$HERMES_SHEBANG_CMD")" == "env" && -n "${HERMES_SHEBANG_ARG:-}" ]]; then
      PYTHON_BIN="$(command -v "$HERMES_SHEBANG_ARG" || true)"
    elif [[ -x "$HERMES_SHEBANG_CMD" ]]; then
      PYTHON_BIN="$HERMES_SHEBANG_CMD"
    fi
  fi
fi

if [[ -z "${PYTHON_BIN:-}" ]]; then
  if [[ "$ALLOW_SYSTEM_PYTHON" == "1" ]]; then
    PYTHON_BIN="python3"
  else
    fail "Hermes Python not found. Set PYTHON_BIN=/path/to/hermes/python or HERMES_VENV_DIR=/path/to/venv. Refusing to use system python3 by default to avoid externally-managed-environment installs."
  fi
fi

TDAI_MEMORY_ENDPOINT="${TDAI_MEMORY_ENDPOINT:-http://127.0.0.1:8420}"
TDAI_MEMORY_API_KEY="${TDAI_MEMORY_API_KEY:-local}"
TDAI_MEMORY_SERVICE_ID="${TDAI_MEMORY_SERVICE_ID:-default}"
WRITE_HERMES_ENV="${WRITE_HERMES_ENV:-1}"

need_cmd curl
need_cmd "$PYTHON_BIN"

if [[ ! -d "$PROVIDER_SRC" ]]; then
  fail "Hermes provider directory not found: $PROVIDER_SRC"
fi

if [[ ! -d "$HERMES_AGENT_DIR" ]]; then
  log "WARN: Hermes agent dir not found: $HERMES_AGENT_DIR"
  log "      Set HERMES_AGENT_DIR if Hermes is installed elsewhere."
fi

log "Downloading Python SDK wheel"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT
curl -fL -o "$TMP_DIR/$SDK_WHEEL_NAME" "$SDK_WHEEL_URL"

log "Installing Python SDK with $PYTHON_BIN"
"$PYTHON_BIN" -m pip install "$TMP_DIR/$SDK_WHEEL_NAME"

log "Installing Hermes provider"
mkdir -p "$HERMES_MEMORY_PLUGIN_DIR"
if [[ -e "$PROVIDER_TARGET" || -L "$PROVIDER_TARGET" ]]; then
  if [[ "$FORCE" == "1" ]]; then
    rm -rf "$PROVIDER_TARGET"
  else
    fail "target already exists: $PROVIDER_TARGET (set FORCE=1 to overwrite)"
  fi
fi
ln -s "$PROVIDER_SRC" "$PROVIDER_TARGET"
log "Provider linked: $PROVIDER_TARGET -> $PROVIDER_SRC"

log "Checking Hermes config"
if [[ -f "$HERMES_CONFIG" ]]; then
  if sed -n '/^memory:/,/^[[:alpha:]_][[:alnum:]_]*:/p' "$HERMES_CONFIG" | grep -q 'provider: memory_tencentdb_v2'; then
    log "memory.provider already set to memory_tencentdb_v2"
  else
    log "Provider installed but NOT enabled by default. Add/edit in $HERMES_CONFIG:"
    cat >&2 <<'EOF'

memory:
  provider: memory_tencentdb_v2
EOF
  fi
else
  log "WARN: $HERMES_CONFIG not found; create it or run Hermes installer first."
  log "      To enable the provider, add:"
  cat >&2 <<'EOF'

memory:
  provider: memory_tencentdb_v2
EOF
fi

_update_env() {
  local key="$1"
  local value="$2"
  local file="$3"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  local tmp
  tmp="$(mktemp)"
  grep -v -E "^(# *)?${key}=" "$file" > "$tmp" || true
  local escaped="$value"
  escaped="${escaped//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  printf '%s="%s"\n' "$key" "$escaped" >> "$tmp"
  mv "$tmp" "$file"
}

if [[ "$WRITE_HERMES_ENV" == "1" ]]; then
  log "Writing Memory SDK env vars to $HERMES_ENV"
  _update_env "TDAI_MEMORY_ENDPOINT" "$TDAI_MEMORY_ENDPOINT" "$HERMES_ENV"
  _update_env "TDAI_MEMORY_API_KEY" "$TDAI_MEMORY_API_KEY" "$HERMES_ENV"
  _update_env "TDAI_MEMORY_SERVICE_ID" "$TDAI_MEMORY_SERVICE_ID" "$HERMES_ENV"
fi

cat >&2 <<EOF

[install-hermes-plugin-v2] Done.
Provider installed at:
  $PROVIDER_TARGET

SDK env file:
  $HERMES_ENV

If not already enabled, add this to $HERMES_CONFIG:

memory:
  provider: memory_tencentdb_v2

Standalone Gateway env:
  TDAI_MEMORY_ENDPOINT="$TDAI_MEMORY_ENDPOINT"
  TDAI_MEMORY_API_KEY="$TDAI_MEMORY_API_KEY"
  TDAI_MEMORY_SERVICE_ID="$TDAI_MEMORY_SERVICE_ID"
EOF
