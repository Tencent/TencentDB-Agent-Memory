# TDAI 按 Agent 隔离改造方案

## 一、问题根因

`memory-tencentdb` 插件在 `~/.openclaw/memory-tdai/` 下维护**单一数据目录**，所有 agent 共享：
- `persona.md` — 统一用户画像
- `conversations/` — 所有 agent 的对话记录
- `scene_blocks/` — 所有场景记忆
- `vectors.db` — 统一向量库

插件在 `before_prompt_build` 阶段（`performAutoRecall`）将 persona + scene_navigation 注入到**每个 agent 的 system prompt**，不区分 agentId。

### 污染链路
```
所有agent对话 → 同一个 conversations/ → 统一 L1 提取 → 统一 persona.md → 注入所有agent
```

## 二、改造目标

**每个 agent 只能访问自己搭档用户的数据**：
- persona.md 按 agent 隔离
- conversations/ 按 agent 隔离
- scene_blocks/ 按 agent 隔离
- records/ 按 agent 隔离
- vectors.db 按 agent 隔离（或按 agentId 分表）

## 三、改造方案

### 方案：per-agent 数据目录

#### 3.1 数据目录结构

**现状：**
```
~/.openclaw/memory-tdai/
├── persona.md
├── conversations/
├── scene_blocks/
├── records/
└── vectors.db
```

**改造后：**
```
~/.openclaw/memory-tdai/
├── agents/
│   ├── duoduo/
│   │   ├── persona.md
│   │   ├── conversations/
│   │   ├── scene_blocks/
│   │   ├── records/
│   │   └── vectors.db
│   ├── sugarbaby/
│   │   ├── persona.md
│   │   ├── conversations/
│   │   ├── scene_blocks/
│   │   ├── records/
│   │   └── vectors.db
│   ├── miumiu/
│   ├── jelly/
│   ├── der/
│   └── zhumi/
└── shared/              ← 保留共享知识（跨agent经验等）
    └── ...
```

#### 3.2 插件代码改动点

##### 改动1：`pluginDataDir` 按 agentId 解析

**文件**：`dist/index.mjs` 第 16969 行

**现状**：
```js
const pluginDataDir = path.join(api.runtime.state.resolveStateDir(), "memory-tdai");
```

**改为**：
```js
// 基础目录
const tdaiBaseDir = path.join(api.runtime.state.resolveStateDir(), "memory-tdai");
// 在 capture/recall 时按 agentId 动态解析子目录
```

**关键**：不能在 register 时固定 agentId，因为一个插件实例服务所有 agent。需要在每次 capture/recall 时从 sessionKey 中提取 agentId。

##### 改动2：L0 capture 按 agentId 分目录

**文件**：`dist/index.mjs` 第 8013 行 `recordConversation`

**现状**：
```js
const outDir = path.join(baseDir, "conversations");
```

**改为**：
```js
// 从 sessionKey 提取 agentId
const agentId = extractAgentId(sessionKey);
const outDir = path.join(baseDir, "agents", agentId, "conversations");
```

##### 改动3：L0 读取按 agentId 过滤

**文件**：`dist/index.mjs` 第 8040 行 `readConversationRecords`

**现状**：读取 `baseDir/conversations/` 下所有文件，按 sessionKey 过滤

**改为**：读取 `baseDir/agents/{agentId}/conversations/`

##### 改动4：L1 records 按 agentId 分目录

所有 `records/` 的读写路径加上 `agents/{agentId}/` 前缀

##### 改动5：persona.md 按 agentId 隔离

**文件**：persona 生成（L3）和读取（recall）时

**现状**：
```js
const personaPath = path.join(pluginDataDir, "persona.md");
```

**改为**：
```js
const personaPath = path.join(pluginDataDir, "agents", agentId, "persona.md");
```

##### 改动6：scene_blocks 按 agentId 隔离

所有 scene_blocks 路径加上 `agents/{agentId}/` 前缀

##### 改动7：vectors.db 按 agentId 隔离

每个 agent 独立的 `vectors.db`，避免向量搜索跨 agent 召回

##### 改动8：recall 时按 agentId 限定搜索范围

**文件**：`performAutoRecall` 函数

在 recall 时从 sessionKey 提取 agentId，只搜索该 agent 的数据目录

#### 3.3 辅助函数

`extractAgentId(sessionKey)` 已存在（第 11551 行），从 `agent:duoduo:feishu:xxx` 格式提取 `duoduo`。

新增：
```js
function resolveAgentDataDir(baseDir, sessionKey) {
    const agentId = extractAgentId(sessionKey);
    if (!agentId) return baseDir; // fallback
    const agentDir = path.join(baseDir, "agents", agentId);
    mkdirSync(agentDir, { recursive: true });
    return agentDir;
}
```

#### 3.4 数据迁移

已有数据需要拆分：

```bash
# 按 sessionKey 中的 agentId 拆分 conversations
# 按 records 中的 agent_id 字段拆分 records
# persona.md 和 scene_blocks 需要重新生成（按 agent）
```

## 四、改动量评估

| 模块 | 改动文件 | 难度 | 说明 |
|------|----------|------|------|
| 数据目录路由 | index.mjs（多处） | 中 | 加 agentId 子路径 |
| L0 capture | recordConversation | 低 | 改 outDir |
| L0 read | readConversationRecords | 低 | 改读取路径 |
| L1 records | 多处读写 | 中 | 加前缀 |
| L2 scene | scene 相关函数 | 中 | 加前缀 |
| L3 persona | persona 读写 | 低 | 改路径 |
| vectors.db | 初始化/搜索 | 中 | 按 agent 分 db |
| recall | performAutoRecall | 中 | 限定搜索范围 |
| 数据迁移 | 新增脚本 | 低 | 一次性 |

**总改动量**：约 20-30 处路径修改，核心逻辑不变

## 五、风险

1. **插件更新覆盖**：memory-tencentdb 更新后会覆盖改动 → 需要 fork 或提 PR
2. **数据迁移**：现有数据需要正确拆分，否则历史记忆丢失
3. **shared-knowledge**：跨 agent 共享经验目前也在 tdai 里，拆分后需要单独处理

## 六、建议执行路径

1. **Fork memory-tencentdb** → 建独立仓库
2. **实现 per-agent 数据目录** → 按上面改动点修改
3. **写数据迁移脚本** → 拆分现有 conversations/records
4. **persona 重新生成** → 每个 agent 基于 L0 重新提炼
5. **测试验证** → 确认糖宝不再读到其他人的数据
6. **持续跟进上游** → 给腾讯提 PR，合入官方版本

---

生成时间：2026-05-20
