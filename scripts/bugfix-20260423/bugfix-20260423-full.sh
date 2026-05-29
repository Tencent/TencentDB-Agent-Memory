#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# bugfix-20260423.sh — OC 2026.4.23 allowConversationAccess 修复
# ═══════════════════════════════════════════════════════════════════
# Issue #73806: OC 2026.4.23 的 Zod schema 使用 .strict() 拒绝
# hooks.allowConversationAccess 字段，导致非捆绑插件无法注册会话钩子
# (llm_input, llm_output, agent_end)。PR #71221 在 4.24 修复。
#
# 本脚本做两件事（均幂等，可安全重复执行）：
#   1. Patch dist JS: 给 hooks zod schema 注入 allowConversationAccess 字段
#   2. 写 openclaw.json: 设置 hooks.allowConversationAccess = true
#
# 版本限制：仅在 OC 2026.4.23 上执行 Part 1，其他版本安全跳过 dist patch。
#           Part 2 (配置写入) 不限版本，始终确保配置存在。
#
# 用法：
#   bash bugfix-20260423.sh [/path/to/openclaw]
#
# 环境变量：
#   OPENCLAW_DIR    — 覆盖 openclaw 安装路径（优先于参数）
#   OPENCLAW_JSON   — 覆盖配置文件路径（默认 ~/.openclaw/openclaw.json）
#   DEBUG=1         — 开启调试输出
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*" >&2; exit 1; }
debug() { [[ "${DEBUG:-}" == "1" ]] && echo -e "${CYAN}[DEBUG]${NC} $*" || true; }

PLUGIN_ID="memory-tencentdb"
OPENCLAW_JSON="${OPENCLAW_JSON:-${HOME}/.openclaw/openclaw.json}"

# ═══════════════════════════════════════════════════════════════════
# Part 1: Patch dist JS (仅 2026.4.23)
# ═══════════════════════════════════════════════════════════════════

_resolve_openclaw_dir() {
    # 参数 > 环境变量 > 自动检测
    if [[ -n "${1:-}" ]]; then
        echo "$1"; return 0
    fi
    if [[ -n "${OPENCLAW_DIR:-}" && -d "${OPENCLAW_DIR}" ]]; then
        echo "$OPENCLAW_DIR"; return 0
    fi
    # 自动定位
    node -e "
      const {dirname, join} = require('path');
      const {realpathSync, existsSync, readFileSync, statSync} = require('fs');
      function walkUp(start) {
        let dir = statSync(start).isDirectory() ? start : dirname(start);
        for (let i = 0; i < 10; i++) {
          const pj = join(dir, 'package.json');
          if (existsSync(pj)) {
            try { if (JSON.parse(readFileSync(pj,'utf8')).name==='openclaw') { console.log(dir); process.exit(0); } } catch {}
          }
          const parent = dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        return null;
      }
      try {
        const {execSync} = require('child_process');
        const bin = execSync('which openclaw',{encoding:'utf8'}).trim();
        const real = realpathSync(bin);
        const found = walkUp(real);
        if (found) { console.log(found); process.exit(0); }
        const content = readFileSync(bin,'utf8');
        const m = content.match(/['\"]([^'\"]*openclaw[^'\"]*\\.(?:js|mjs))['\"]/) ||
                  content.match(/['\"]([^'\"]*openclaw[^'\"]*)['\"].*node/);
        if (m) { const f = walkUp(realpathSync(m[1])); if (f) { console.log(f); process.exit(0); } }
      } catch {}
      const searchDirs = [
        join(process.env.HOME||'/root','.local/share/pnpm'),
        join(process.env.HOME||'/root','.local/node/lib/node_modules'),
        '/usr/local/lib/node_modules','/usr/lib/node_modules',
      ];
      for (const base of searchDirs) {
        if (!existsSync(base)) continue;
        try {
          const {execSync:e2} = require('child_process');
          const out = e2('find '+JSON.stringify(base)+' -maxdepth 8 -name package.json -path \"*/openclaw/package.json\" 2>/dev/null',{encoding:'utf8',timeout:5000}).trim();
          for (const line of out.split('\\n')) {
            if (!line) continue;
            try { if (JSON.parse(readFileSync(line,'utf8')).name==='openclaw') { console.log(dirname(line)); process.exit(0); } } catch {}
          }
        } catch {}
      }
      process.exit(1);
    " 2>/dev/null
}

patch_dist_js() {
    local oc_dir
    oc_dir="$(_resolve_openclaw_dir "${1:-}")" || {
        warn "[Part 1] 找不到 OpenClaw 安装目录，跳过 dist patch"
        return 0
    }

    local dist_dir="$oc_dir/dist"
    [[ -d "$dist_dir" ]] || { warn "[Part 1] dist 目录不存在: $dist_dir，跳过"; return 0; }

    local version
    version=$(grep -oP '"version"\s*:\s*"\K[^"]+' "$oc_dir/package.json" 2>/dev/null || echo "unknown")
    info "[Part 1] OpenClaw 版本: $version"

    # 版本门控：仅 2026.4.23
    if [[ ! "$version" =~ ^2026\.4\.23($|[-\.]) ]]; then
        ok "[Part 1] 版本 $version 不需要 schema patch，跳过"
        return 0
    fi

    # 精确定位：hooks zod schema 的唯一特征
    local -a candidates
    mapfile -t candidates < <(
        grep -rl 'allowPromptInjection' "$dist_dir" --include='*.js' 2>/dev/null | while read -r _f; do
            if perl -0777 -ne 'exit(0) if /allowPromptInjection\s*:\s*[a-zA-Z_\$][a-zA-Z0-9_\$]*\s*\.\s*boolean\s*\(\s*\)\s*\.\s*optional\s*\(\s*\)\s*[,\s]*\}\s*\)\s*\.\s*strict\s*\(\s*\)/; exit(1)' "$_f" 2>/dev/null; then
                echo "$_f"
            fi
        done
    )

    if [[ ${#candidates[@]} -eq 0 ]]; then
        warn "[Part 1] 未找到 hooks zod schema 目标文件，跳过"
        return 0
    elif [[ ${#candidates[@]} -gt 1 ]]; then
        warn "[Part 1] 发现 ${#candidates[@]} 个匹配文件（预期 1），安全起见跳过"
        return 0
    fi

    local target="${candidates[0]}"
    local relpath="${target#$dist_dir/}"
    debug "[Part 1] 目标: $relpath"

    # 幂等：目标文件中已包含 allowConversationAccess → 跳过
    if grep -q 'allowConversationAccess' "$target" 2>/dev/null; then
        ok "[Part 1] allowConversationAccess 已存在于 $relpath，跳过"
        return 0
    fi

    # 备份
    [[ -f "${target}.pre-aca-patch.bak" ]] || cp "$target" "${target}.pre-aca-patch.bak"

    # 注入：用精确变量名匹配，避免贪婪回溯
    perl -0777 -i -pe '
        s/(allowPromptInjection\s*:\s*[a-zA-Z_\$][a-zA-Z0-9_\$]*\s*\.\s*boolean\s*\(\s*\)\s*\.\s*optional\s*\(\s*\))(\s*\}\s*\)\s*\.\s*strict\s*\(\s*\))/$1,allowConversationAccess:z.boolean().optional()$2/
    ' "$target"

    # 验证
    if grep -q 'allowConversationAccess' "$target" 2>/dev/null; then
        ok "[Part 1] $relpath — patch 成功"
    else
        warn "[Part 1] patch 验证失败，恢复备份"
        cp "${target}.pre-aca-patch.bak" "$target"
        return 1
    fi
}

# ═══════════════════════════════════════════════════════════════════
# Part 2: 写入 openclaw.json (不限版本，始终确保配置存在)
# ═══════════════════════════════════════════════════════════════════

patch_config_json() {
    if [[ ! -f "$OPENCLAW_JSON" ]]; then
        warn "[Part 2] openclaw.json 不存在: $OPENCLAW_JSON，跳过"
        return 0
    fi

    # 幂等检测
    local exists
    exists=$(python3 -c "
import json
try:
    with open('$OPENCLAW_JSON') as f:
        cfg = json.load(f)
    val = cfg.get('plugins',{}).get('entries',{}).get('$PLUGIN_ID',{}).get('hooks',{}).get('allowConversationAccess')
    print('yes' if val is True else 'no')
except Exception:
    print('no')
" 2>/dev/null || echo "no")

    if [[ "$exists" == "yes" ]]; then
        ok "[Part 2] hooks.allowConversationAccess 已存在，跳过"
        return 0
    fi

    # 写入
    python3 -c "
import json

with open('$OPENCLAW_JSON') as f:
    cfg = json.load(f)

entry = cfg.setdefault('plugins', {}).setdefault('entries', {}).setdefault('$PLUGIN_ID', {})
hooks = entry.setdefault('hooks', {})
hooks['allowConversationAccess'] = True

with open('$OPENCLAW_JSON', 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write('\n')
"
    ok "[Part 2] hooks.allowConversationAccess = true 已写入"
}

# ═══════════════════════════════════════════════════════════════════
# 主入口
# ═══════════════════════════════════════════════════════════════════

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  bugfix-20260423: allowConversationAccess 一键修复${NC}"
echo -e "${CYAN}  Issue #73806 | 适用版本: OC 2026.4.23${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"
echo ""

# ── Step 1: 停止 Gateway ──
info "[Step 1] 停止 Gateway..."
openclaw gateway stop 2>/dev/null || true
sleep 10

# 确认已停止
if ps aux | grep -v grep | grep -q 'openclaw-gateway'; then
    warn "检测到 openclaw-gateway 仍在运行，尝试强制停止..."
    pkill -9 -f 'openclaw-gateway' 2>/dev/null || true
    sleep 3
fi

if ps aux | grep -v grep | grep -q 'openclaw-gateway'; then
    fail "[Step 1] 无法停止 openclaw-gateway，请手动处理后重试"
fi
ok "[Step 1] Gateway 已停止"
echo ""

# ── Step 2: 执行 Patch ──
info "[Step 2] 执行 Patch..."
if ! patch_dist_js "${1:-}"; then
    fail "[Step 2] dist JS patch 失败"
fi
if ! patch_config_json; then
    fail "[Step 2] openclaw.json 写入失败"
fi
echo ""

# ── Step 3: 验证 ──
info "[Step 3] 验证结果..."
echo ""

# 3.1 验证 openclaw.json
info "  [3.1] 检查 openclaw.json"
if grep -q '"allowConversationAccess"' "$OPENCLAW_JSON" 2>/dev/null; then
    _json_line=$(grep -n 'allowConversationAccess' "$OPENCLAW_JSON")
    ok "  openclaw.json: allowConversationAccess ✓"
    echo -e "  ${CYAN}${_json_line}${NC}"
else
    fail "[Step 3.1] openclaw.json 中未找到 allowConversationAccess"
fi
echo ""

# 3.2 验证 dist JS — 只检查 zod-schema-BhKK4qYw.js
info "  [3.2] 检查 zod-schema-BhKK4qYw.js"
_oc_dir="$(_resolve_openclaw_dir "${1:-}" 2>/dev/null)" || _oc_dir=""
_zod_file="$_oc_dir/dist/zod-schema-BhKK4qYw.js"
if [[ -n "$_oc_dir" && -f "$_zod_file" ]]; then
    _match_count=$(grep -c 'allowConversationAccess' "$_zod_file" 2>/dev/null || echo "0")

    if [[ "$_match_count" -eq 0 ]]; then
        fail "[Step 3.2] zod-schema-BhKK4qYw.js 中未找到 allowConversationAccess"
    elif [[ "$_match_count" -eq 1 ]]; then
        ok "  zod-schema-BhKK4qYw.js: allowConversationAccess 出现 1 次 ✓"
        echo -e "  ${CYAN}匹配行:${NC}"
        grep -n 'allowConversationAccess' "$_zod_file" | head -1 | sed 's/^/  /'
    else
        fail "[Step 3.2] zod-schema-BhKK4qYw.js 中 allowConversationAccess 出现 $_match_count 次（预期 1 次），可能重复注入"
    fi
else
    fail "[Step 3.2] 文件不存在: $_zod_file"
fi
echo ""

# ── Step 4: 重启 Gateway ──
info "[Step 4] 重启 Gateway..."
openclaw gateway start
sleep 10

if ps aux | grep -v grep | grep -q 'openclaw-gateway'; then
    ok "[Step 4] Gateway 已启动 (pid=$(pgrep -f 'openclaw-gateway' | head -1))"
else
    fail "[Step 4] Gateway 启动失败，请检查日志"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ bugfix-20260423 修复完成，Gateway 已重启${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""
