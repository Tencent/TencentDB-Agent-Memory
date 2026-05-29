#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# OpenClaw Patch: after_tool_call hook 注入 session messages
# ═══════════════════════════════════════════════════════════════════
# 用途：在 after_tool_call hookEvent 中注入 ctx.params.session?.messages，
#       使 context-offload 等插件能在工具调用后访问完整历史消息列表。
#
# 兼容策略（按优先级尝试，首个成功即停止）：
#   策略 1: AST-like — 搜索 hookEvent 对象中 durationMs 字段，在其后追加 messages
#   策略 2: 旧版 dispatch-*.js — 针对早期版本文件布局
#   策略 3: runAfterToolCall 锚点 — 在 hookEvent 关闭大括号前插入
#   策略 4: 通用 fallback — 基于 after_tool_call + durationMs 的宽松匹配
#
# 用法：
#   bash openclaw-after-tool-call-messages.patch.sh
#   bash openclaw-after-tool-call-messages.patch.sh /custom/path/to/openclaw
#
# 幂等：已 patch 过的文件会自动跳过，可安全重复执行。
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }
debug() { [[ "${DEBUG:-}" == "1" ]] && echo -e "${CYAN}[DEBUG]${NC} $*" || true; }

# ─── 定位 OpenClaw 安装目录 ──────────────────────────────────────
# Uses Node.js require.resolve to locate the package root — handles
# nvm, pnpm, npm, yarn, volta, and any other layout automatically.
_node_resolve_openclaw() {
    node -e "
      const {dirname, join} = require('path');
      const {realpathSync, existsSync, readFileSync, statSync} = require('fs');

      // Helper: walk up from a file/dir to find the openclaw package root
      function walkUp(start) {
        let dir = statSync(start).isDirectory() ? start : dirname(start);
        for (let i = 0; i < 10; i++) {
          const pj = join(dir, 'package.json');
          if (existsSync(pj)) {
            try {
              const pkg = JSON.parse(readFileSync(pj, 'utf8'));
              if (pkg.name === 'openclaw') return dir;
            } catch {}
          }
          const parent = dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        return null;
      }

      // Strategy 1: which openclaw → realpath → walk up
      try {
        const {execSync} = require('child_process');
        const bin = execSync('which openclaw', {encoding:'utf8'}).trim();
        const real = realpathSync(bin);
        const found = walkUp(real);
        if (found) { console.log(found); process.exit(0); }

        // pnpm uses shell shims: the bin file is a script, not a symlink.
        // Read the shim content to extract the real entry point path.
        const content = readFileSync(bin, 'utf8');
        // pnpm shim contains a line like: exec node \"/path/.../openclaw/dist/cli.js\"
        // or: require(\"/path/.../openclaw/dist/cli.js\")
        const m = content.match(/['\"]([^'\"]*openclaw[^'\"]*\\.(?:js|mjs))['\"]/) ||
                  content.match(/['\"]([^'\"]*openclaw[^'\"]*)['\"].*node/);
        if (m) {
          const shimTarget = realpathSync(m[1]);
          const found2 = walkUp(shimTarget);
          if (found2) { console.log(found2); process.exit(0); }
        }
      } catch {}

      // Strategy 2: search common pnpm/npm global paths
      const {execSync: exec2} = require('child_process');
      const searchDirs = [
        join(process.env.HOME || '/root', '.local/share/pnpm'),
        join(process.env.HOME || '/root', '.local/node/lib/node_modules'),
        '/usr/local/lib/node_modules',
        '/usr/lib/node_modules',
      ];
      for (const base of searchDirs) {
        if (!existsSync(base)) continue;
        try {
          const out = exec2(
            'find ' + JSON.stringify(base) + ' -maxdepth 8 -name package.json -path \"*/openclaw/package.json\" 2>/dev/null',
            {encoding:'utf8', timeout: 5000}
          ).trim();
          for (const line of out.split('\\n')) {
            if (!line) continue;
            try {
              const pkg = JSON.parse(readFileSync(line, 'utf8'));
              if (pkg.name === 'openclaw') { console.log(dirname(line)); process.exit(0); }
            } catch {}
          }
        } catch {}
      }

      process.exit(1);
    " 2>/dev/null
}

if [[ -n "${1:-}" ]]; then
    OPENCLAW_DIR="$1"
elif OPENCLAW_DIR="$(_node_resolve_openclaw)"; then
    debug "Node.js resolved openclaw → $OPENCLAW_DIR"
else
    fail "找不到 OpenClaw 安装目录。请手动指定：\n       bash $0 /path/to/openclaw"
fi

DIST_DIR="$OPENCLAW_DIR/dist"

if [[ ! -d "$DIST_DIR" ]]; then
    fail "dist 目录不存在: $DIST_DIR"
fi

info "OpenClaw 目录: $OPENCLAW_DIR"

# ─── 检测 OpenClaw 版本 ──────────────────────────────────────────
VERSION=$(grep -oP '"version"\s*:\s*"\K[^"]+' "$OPENCLAW_DIR/package.json" 2>/dev/null || echo "unknown")
info "检测到 OpenClaw 版本: $VERSION"

# ─── 已 patch 检测 ───────────────────────────────────────────────
# 核心标记：hookEvent 内部 durationMs 之后紧跟 messages 注入
# 支持多种缩进格式（tab / 空格 / 混合）
INJECTION_CODE='messages: ctx.params.session?.messages'
INJECTION_CODE_ALT='messages:ctx.params.session?.messages'

is_already_patched() {
    local f="$1"
    # 方法 1: 精确检测 — durationMs 后面紧跟 messages 注入（允许任意空白）
    if perl -0777 -ne 'exit(0) if /durationMs[,\s]*\n\s*messages\s*:\s*ctx\.params\.session\?\s*\.messages/; exit(1)' "$f" 2>/dev/null; then
        return 0
    fi
    # 方法 2: 上下文检测 — after_tool_call hookEvent 对象内部（durationMs 附近）有 messages 注入
    # 注意: 不能用全文件检测，因为 before_compaction 也有 messages: ctx.params.session.messages
    if perl -0777 -ne 'exit(0) if /(?:hookEvent|hook_event)\s*=\s*\{[\s\S]{0,500}durationMs[\s\S]{0,100}messages\s*:\s*ctx\.params\.session/; exit(1)' "$f" 2>/dev/null; then
        return 0
    fi
    return 1
}

verify_patch() {
    local f="$1"
    is_already_patched "$f"
}

# ─── 备份工具 ────────────────────────────────────────────────────
backup_file() {
    local f="$1"
    local bak="${f}.pre-offload-patch.bak"
    if [[ ! -f "$bak" ]]; then
        cp "$f" "$bak"
        debug "备份: $bak"
    fi
}

# ─── 查找所有候选文件 ────────────────────────────────────────────
# 收集所有包含 after_tool_call 的 JS 文件（不限子目录深度）
mapfile -t CANDIDATE_FILES < <(grep -rl 'after_tool_call' "$DIST_DIR" --include='*.js' 2>/dev/null || true)

if [[ ${#CANDIDATE_FILES[@]} -eq 0 ]]; then
    warn "在 $DIST_DIR 下未找到包含 after_tool_call 的 JS 文件"
fi

info "找到 ${#CANDIDATE_FILES[@]} 个候选文件"

PATCHED=0
SKIPPED=0
FAILED=0

# ─── 对每个候选文件尝试多种策略 ──────────────────────────────────
for f in "${CANDIDATE_FILES[@]}"; do
    fname="$(basename "$f")"
    relpath="${f#$DIST_DIR/}"

    # 已 patch → 跳过
    if is_already_patched "$f"; then
        warn "$relpath — 已经 patch 过，跳过"
        ((SKIPPED++)) || true
        continue
    fi

    # 确认文件中有 durationMs（hookEvent 的标志字段）
    if ! grep -q 'durationMs' "$f" 2>/dev/null; then
        debug "$relpath — 不含 durationMs，非 patch 目标，跳过"
        continue
    fi

    # 确认 durationMs 附近有 after_tool_call 上下文（避免误匹配 before_compaction 等）
    if ! perl -0777 -ne 'exit(0) if /after_tool_call[\s\S]{0,2000}durationMs/; exit(1)' "$f" 2>/dev/null; then
        debug "$relpath — durationMs 不在 after_tool_call 上下文中，跳过"
        continue
    fi

    backup_file "$f"
    applied=false

    # ── 策略 1: hookEvent 对象中 durationMs 是最后一个字段 ────────
    # 匹配: durationMs<换行><空白>};<换行><空白>hookRunnerAfter
    # 或:   durationMs<换行><空白>};<换行><空白>await ...hookRunner...afterToolCall
    # 缩进用 \s+ 宽松匹配
    if [[ "$applied" == "false" ]]; then
        if perl -0777 -ne 'exit(0) if /durationMs\s*\n(\s*)\};\s*\n\s*(hookRunnerAfter|await\s+\S*hookRunner\S*\.runAfterToolCall|hookRunner\S*\.runAfterToolCall)/; exit(1)' "$f" 2>/dev/null; then
            debug "$relpath — 命中策略1 (hookRunnerAfter 锚点)"
            perl -0777 -i -pe 's/(durationMs)\s*\n(\s*\};\s*\n\s*(?:hookRunnerAfter|await\s+\S*hookRunner\S*\.runAfterToolCall|hookRunner\S*\.runAfterToolCall))/$1,\n\t\t\tmessages: ctx.params.session?.messages\n$2/' "$f"
            if verify_patch "$f"; then
                ok "[策略1] $relpath — patch 成功"
                ((PATCHED++)) || true
                applied=true
            fi
        fi
    fi

    # ── 策略 2: 旧版 dispatch-*.js — durationMs 行末独占 ─────────
    if [[ "$applied" == "false" ]]; then
        if echo "$relpath" | grep -qP 'dispatch-.*\.js' 2>/dev/null; then
            # 匹配行末独占的 durationMs（前面是空白）
            if grep -qP '^\s+durationMs\s*$' "$f" 2>/dev/null; then
                debug "$relpath — 命中策略2 (旧版 dispatch)"
                sed -i -E 's/^(\s+)(durationMs)\s*$/\1\2,\n\1messages: ctx.params.session?.messages/' "$f"
                if verify_patch "$f"; then
                    ok "[策略2] $relpath — patch 成功"
                    ((PATCHED++)) || true
                    applied=true
                fi
            fi
        fi
    fi

    # ── 策略 3: durationMs 后跟 }; 但无 hookRunnerAfter 锚点 ────
    # 匹配: durationMs<换行><空白>}; （hookEvent 闭合）
    # 通过上下文（附近有 after_tool_call）确认是正确的对象
    if [[ "$applied" == "false" ]]; then
        # 找到包含 durationMs 且附近(±20行)有 after_tool_call 的代码区域
        if perl -0777 -ne 'exit(0) if /after_tool_call[\s\S]{0,800}durationMs\s*\n(\s*)\};/; exit(1)' "$f" 2>/dev/null; then
            debug "$relpath — 命中策略3 (durationMs→}; 邻近 after_tool_call)"
            # 只替换 after_tool_call 上下文附近的 durationMs → };
            perl -0777 -i -pe 's/(after_tool_call[\s\S]{0,800}durationMs)\s*\n(\s*\};)/$1,\n\t\t\tmessages: ctx.params.session?.messages\n$2/' "$f"
            if verify_patch "$f"; then
                ok "[策略3] $relpath — patch 成功"
                ((PATCHED++)) || true
                applied=true
            fi
        fi
    fi

    # ── 策略 4: 通用 fallback — hookEvent 赋值中的 durationMs ────
    # 匹配形如: const hookEvent = { ... durationMs ... }
    # 或: hookEvent = { ... durationMs ... }
    # 用 perl 找到包含 after_tool_call 和 durationMs 的对象字面量，在 durationMs 后插入
    if [[ "$applied" == "false" ]]; then
        # 极宽松: 在文件中找到 "durationMs" 后面最近的 "}" 或 "};" ，在中间插入
        # 但限制在 after_tool_call 关键字附近 2000 字符内
        if perl -0777 -ne 'exit(0) if /after_tool_call[\s\S]{0,2000}?(?:hookEvent|hook_event)[\s\S]{0,500}?durationMs/; exit(1)' "$f" 2>/dev/null; then
            debug "$relpath — 命中策略4 (通用 fallback)"
            # 在 durationMs 后追加 (仅首次匹配)
            perl -0777 -i -pe '
                my $done = 0;
                s/(after_tool_call[\s\S]{0,2000}?(?:hookEvent|hook_event)[\s\S]{0,500}?durationMs)\s*\n(\s*)(\};)/
                    if (!$done) { $done = 1; "$1,\n$2\tmessages: ctx.params.session?.messages\n$2$3" }
                    else { "$1\n$2$3" }
                /ge;
            ' "$f"
            if verify_patch "$f"; then
                ok "[策略4] $relpath — patch 成功"
                ((PATCHED++)) || true
                applied=true
            else
                warn "[策略4] $relpath — patch 后验证失败，恢复备份"
                cp "${f}.pre-offload-patch.bak" "$f"
            fi
        fi
    fi

    # ── 无策略命中 ───────────────────────────────────────────────
    if [[ "$applied" == "false" ]]; then
        debug "$relpath — 无策略命中"
        ((FAILED++)) || true
    fi
done

# ─── 结果报告 ────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Patch 完成  (OpenClaw $VERSION)${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  成功: ${GREEN}${PATCHED}${NC}  跳过: ${YELLOW}${SKIPPED}${NC}  失败: ${RED}${FAILED}${NC}"
echo ""
if [[ $PATCHED -gt 0 ]]; then
    echo -e "  ${CYAN}重启 OpenClaw 后生效。${NC}"
    echo -e "  ${CYAN}备份文件: *.pre-offload-patch.bak${NC}"
elif [[ $SKIPPED -gt 0 && $FAILED -eq 0 ]]; then
    echo -e "  ${YELLOW}所有目标文件已 patch，无需重复操作。${NC}"
elif [[ $FAILED -gt 0 ]]; then
    echo -e "  ${RED}部分文件未能 patch。可能需要手动检查或更新 patch 脚本。${NC}"
    echo -e "  ${RED}提示：设置 DEBUG=1 运行以查看详细匹配过程：${NC}"
    echo -e "  ${RED}  DEBUG=1 bash $0 $OPENCLAW_DIR${NC}"
else
    echo -e "  ${RED}未找到匹配的目标文件，请确认 OpenClaw 版本。${NC}"
    echo -e "  ${RED}提示：设置 DEBUG=1 运行以查看详细匹配过程：${NC}"
    echo -e "  ${RED}  DEBUG=1 bash $0 $OPENCLAW_DIR${NC}"
fi
echo ""

# ─── 退出码 ───────────────────────────────────────────────────────
# 0: 成功（至少有一个文件 patch 成功或已跳过）
# 1: 失败（无任何 patch 成功且无已跳过的文件）
if [[ $PATCHED -gt 0 || $SKIPPED -gt 0 ]]; then
    exit 0
else
    exit 1
fi
