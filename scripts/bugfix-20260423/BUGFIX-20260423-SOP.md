# Bugfix-20260423 打镜像 SOP

> **适用版本**: OpenClaw 2026.4.23  
> **修复问题**: Issue #73806 — Zod schema `.strict()` 拒绝 `hooks.allowConversationAccess`，导致非捆绑插件无法注册会话钩子  
> **脚本位置**: `scripts/bugfix-20260423.sh`

---

## 步骤一：停止 Gateway

```bash
openclaw gateway stop
```

确认已停止：

```bash
ps aux | grep gateway
```

确保没有 `openclaw-gateway` 进程在运行。

---

## 步骤二：执行 Patch

```bash
cd /path/to/memory-tdai/scripts
bash bugfix-20260423.sh
```

---

## 步骤三：验证

### 3.1 验证 openclaw.json 配置

```bash
cat ~/.openclaw/openclaw.json | python3 -m json.tool | grep allowConversationAccess
```

预期输出：

```
"allowConversationAccess": true
```

确认在 `plugins.entries.memory-tencentdb.hooks` 下。

### 3.2 验证 Zod Schema dist 文件

先定位 OpenClaw 安装目录（路径因环境而异，以下仅为示例）：

```bash
# 方式一：通过 which 自动定位
OC_DIR=$(node -e "const p=require('path'),f=require('fs'); \
  const bin=require('child_process').execSync('which openclaw',{encoding:'utf8'}).trim(); \
  let d=p.dirname(f.realpathSync(bin)); \
  while(d!=p.dirname(d)){if(f.existsSync(p.join(d,'package.json'))){console.log(d);break;}d=p.dirname(d);}")
echo "$OC_DIR"

# 方式二：手动指定（示例路径，请根据实际环境替换）
# OC_DIR=~/.local/share/pnpm/global/5/.pnpm/openclaw@2026.4.23_@napi-rs+canvas@0.1.100/node_modules/openclaw
```

然后检查 `zod-schema-BhKK4qYw.js`：

```bash
cat "$OC_DIR/dist/zod-schema-BhKK4qYw.js" | grep allowConversationAccess -n
```

验证要点：

1. `allowConversationAccess` 已出现在输出中
2. **只出现了一次**（只有一行匹配）
3. 所在行的上下文形如：`allowPromptInjection:z.boolean().optional(),allowConversationAccess:z.boolean().optional()}).strict().optional()`

<!-- TODO: 贴验证截图 -->

---

## 验证通过后

两项验证均通过即可重新启动 Gateway：

```bash
openclaw gateway run
```
