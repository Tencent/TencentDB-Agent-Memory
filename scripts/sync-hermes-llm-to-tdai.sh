#!/usr/bin/env bash
#
# sync-hermes-llm-to-tdai.sh — 读取系统 Hermes 模型配置，同步到 TDAI Gateway
#
# 前置条件：
#   1. memory-tencentdb-ctl.sh 存在
#   2. ~/.hermes/config.yaml 存在且包含模型配置
#
# 用法：
#   bash sync-hermes-llm-to-tdai.sh [--restart] [--dry-run] [--hermes]
#
# 参数语义：
#   --restart    仅当 CTL 脚本的 `status` 显示 Gateway 当前为 RUNNING 时，
#                才透传给 `memory-tencentdb-ctl.sh config llm` 执行重启；
#                若当前未运行，则本脚本只同步配置，不拉起新进程。
#   --hermes     以 hermes 集成模式调用 CTL（影响 status 判定与配置落点）
#   --standalone 以 standalone 模式调用 CTL
#   --dry-run    透传给 CTL，预演写配置但不真正落盘
#
# 可选环境变量：
#   HERMES_HOME            hermes 主目录（默认 ~/.hermes）
#   MEMORY_TENCENTDB_ROOT  TDAI 统一根目录（默认 ~/.memory-tencentdb）
#

set -euo pipefail

SCRIPT_NAME="sync-hermes-llm-to-tdai"
USER_HOME="${HOME:-$(eval echo "~$(whoami)")}"

# ============================================================
# 路径
# ============================================================

HERMES_HOME="${HERMES_HOME:-$USER_HOME/.hermes}"
HERMES_CONFIG="$HERMES_HOME/config.yaml"

MEMORY_TENCENTDB_ROOT="${MEMORY_TENCENTDB_ROOT:-$USER_HOME/.memory-tencentdb}"
TDAI_INSTALL_DIR="${TDAI_INSTALL_DIR:-$MEMORY_TENCENTDB_ROOT/tdai-memory-openclaw-plugin}"

CTL_SCRIPT="$TDAI_INSTALL_DIR/scripts/memory-tencentdb-ctl.sh"

# ============================================================
# 通用 helpers
# ============================================================

log()  { printf '[%s] %s\n' "$SCRIPT_NAME" "$*"; }
warn() { printf '[%s:warn] %s\n' "$SCRIPT_NAME" "$*" >&2; }
die()  { printf '[%s:error] %s\n' "$SCRIPT_NAME" "$*" >&2; exit "${2:-1}"; }

should_restart_gateway() {
    local ctl_mode_args=()
    case "${SYNC_MODE:-standalone}" in
        hermes) ctl_mode_args+=("--hermes") ;;
        *)      ctl_mode_args+=("--standalone") ;;
    esac

    local status_out
    status_out="$(bash "$CTL_SCRIPT" "${ctl_mode_args[@]}" status 2>&1 || true)"

    if printf '%s\n' "$status_out" | grep -Eq 'state[[:space:]]*:[[:space:]]*RUNNING'; then
        log "通过 ctl status 检测到 Gateway 正在运行，允许执行 --restart"
        return 0
    fi

    warn "ctl status 未显示 Gateway 处于 RUNNING；本次仅同步配置，不执行 --restart，也不会拉起新进程。"
    return 1
}

# ============================================================
# Step 1: 检查 memory-tencentdb-ctl.sh 是否存在
# ============================================================

if [[ ! -f "$CTL_SCRIPT" ]]; then
    # 也尝试旧路径
    _LEGACY_CTL="$USER_HOME/tdai-memory-openclaw-plugin/scripts/memory-tencentdb-ctl.sh"
    if [[ -f "$_LEGACY_CTL" ]]; then
        CTL_SCRIPT="$_LEGACY_CTL"
        warn "使用旧路径: $CTL_SCRIPT"
    else
        die "memory-tencentdb-ctl.sh 不存在，TDAI 未安装。退出。" 1
    fi
fi

log "找到 ctl 脚本: $CTL_SCRIPT"

# ============================================================
# Step 2: 检查 hermes config.yaml
# ============================================================

if [[ ! -f "$HERMES_CONFIG" ]]; then
    die "Hermes 配置文件不存在: $HERMES_CONFIG" 1
fi

log "读取 Hermes 配置: $HERMES_CONFIG"

# ============================================================
# Step 3: 从 hermes config.yaml 提取模型配置
# ============================================================

need_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "必需命令未找到: $1" 127
}

need_cmd python3

# 使用 python3 安全解析 YAML，提取 model 段的 default / base_url / api_key
read_hermes_model_config() {
    python3 - "$HERMES_CONFIG" <<'PYEOF'
import sys, json

config_path = sys.argv[1]

# 尝试使用 PyYAML；如果不存在则手动逐行解析
try:
    import yaml
    with open(config_path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    model_section = cfg.get("model", {})
    result = {
        "model":    model_section.get("default", ""),
        "base_url": model_section.get("base_url", ""),
        "api_key":  model_section.get("api_key", ""),
    }
    print(json.dumps(result))
except ImportError:
    # PyYAML 不可用，用简单逐行解析提取 model 段
    import re
    with open(config_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    in_model = False
    result = {"model": "", "base_url": "", "api_key": ""}
    for line in lines:
        stripped = line.rstrip("\n")
        # 检测 model: 顶层段
        if re.match(r"^model:\s*$", stripped) or re.match(r"^model:\s*#", stripped):
            in_model = True
            continue
        # 进入新的顶层段则退出
        if in_model and re.match(r"^[A-Za-z_]", stripped):
            break
        if in_model:
            m = re.match(r"^\s+default:\s*(.+)", stripped)
            if m:
                result["model"] = m.group(1).strip().strip("'\"")
            m = re.match(r"^\s+base_url:\s*(.+)", stripped)
            if m:
                result["base_url"] = m.group(1).strip().strip("'\"")
            m = re.match(r"^\s+api_key:\s*(.+)", stripped)
            if m:
                result["api_key"] = m.group(1).strip().strip("'\"")
    print(json.dumps(result))
PYEOF
}

MODEL_JSON="$(read_hermes_model_config)"

HERMES_MODEL="$(printf '%s' "$MODEL_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["model"])')"
HERMES_BASE_URL="$(printf '%s' "$MODEL_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["base_url"])')"
HERMES_API_KEY="$(printf '%s' "$MODEL_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["api_key"])')"

# 校验必需字段
if [[ -z "$HERMES_MODEL" ]]; then
    die "Hermes 配置中 model.default 为空" 1
fi
if [[ -z "$HERMES_BASE_URL" ]]; then
    die "Hermes 配置中 model.base_url 为空" 1
fi
if [[ -z "$HERMES_API_KEY" ]]; then
    die "Hermes 配置中 model.api_key 为空" 1
fi

log "Hermes 模型配置:"
log "  model    = $HERMES_MODEL"
log "  base_url = $HERMES_BASE_URL"
log "  api_key  = <${#HERMES_API_KEY} chars>"

# ============================================================
# Step 4: 透传参数（--restart / --dry-run / --hermes）
# ============================================================

CTL_EXTRA_ARGS=()
SYNC_MODE="standalone"
REQUEST_RESTART=0
for arg in "$@"; do
    case "$arg" in
        --restart)
            REQUEST_RESTART=1
            ;;
        --hermes)
            SYNC_MODE="hermes"
            CTL_EXTRA_ARGS+=("$arg")
            ;;
        --standalone)
            SYNC_MODE="standalone"
            CTL_EXTRA_ARGS+=("$arg")
            ;;
        --dry-run)
            CTL_EXTRA_ARGS+=("$arg")
            ;;
        *)
            warn "忽略未知参数: $arg"
            ;;
    esac
done

if [[ $REQUEST_RESTART -eq 1 ]]; then
    # 新语义：--restart 只在 Gateway 当前已运行时才生效。
    # 这里复用 CTL 的 status 输出作为唯一事实来源，避免本脚本
    # 自己维护另一套“端口监听/健康检查”判定逻辑。
    if should_restart_gateway; then
        CTL_EXTRA_ARGS+=("--restart")
    else
        log "已按新逻辑跳过 --restart。"
    fi
fi

# ============================================================
# Step 5: 调用 memory-tencentdb-ctl.sh config llm 同步配置
# ============================================================

log "调用 memory-tencentdb-ctl.sh config llm 同步配置到 TDAI ..."

bash "$CTL_SCRIPT" "${CTL_EXTRA_ARGS[@]+"${CTL_EXTRA_ARGS[@]}"}" \
    config llm \
    --api-key  "$HERMES_API_KEY" \
    --base-url "$HERMES_BASE_URL" \
    --model    "$HERMES_MODEL"

log "同步完成。"
log ""
log "如需立即重启 Gateway 使配置生效，请重新运行并追加 --restart："
log "  bash $0 --restart"
