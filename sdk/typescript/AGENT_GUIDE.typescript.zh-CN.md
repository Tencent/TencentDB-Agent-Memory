# Agent 接入指南（TypeScript）

本文讲怎么把 `@tencentdb-agent-memory/memory-sdk-ts` 接到一个 AI Agent 里。SDK 14 个 API 的速查见 [`README.md`](./README.md)，本文讲**怎么把它们组装成一套长期记忆**。

---

## 接入要做的四件事

```
用户输入  →  ① 召回（注入 prompt） → LLM → ② 捕获（写 L0）
                            ↑
                  ③ 工具：让 LLM 自己再查
                            ↑
                  ④ 错误降级：失败不挂主流程
```

---

## 0. 初始化

```typescript
import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts";

const client = new MemoryClient({
  endpoint: "https://your-memory-gateway",
  apiKey: process.env.MEMORY_API_KEY,
  serviceId: "your-instance-id",
});
```

注意：**必须传 config 对象**，不能传裸 transport（`new MemoryClient(transport)` 是单测 mock 用的，会让 `client.readFile()` 失效）。

`serviceId` 决定 memory space 隔离粒度，同 id 数据共享、不同 id 完全隔离。

---

## 1. 召回（Recall）

在用户消息发给 LLM 前，并行拉三类记忆，拼到 system prompt 里。

```typescript
async function recall(client: MemoryClient, userQuery: string) {
  const [l1, persona, scenes] = await Promise.allSettled([
    client.searchAtomic({ query: userQuery, limit: 5 }),
    client.readCore(),                              // L3 用户画像
    client.listScenarios({}),                       // L2 场景索引
  ]);

  const l1Items = l1.status === "fulfilled" ? l1.value.items : [];
  const personaText = persona.status === "fulfilled" ? persona.value.content : null;
  const sceneList = scenes.status === "fulfilled" ? scenes.value.entries : [];

  return formatPrompt(l1Items, personaText, sceneList);
}
```

`Promise.allSettled` 是关键——任何一路超时/失败，其它两路结果照常用，不影响主对话。

### 拼 prompt 的两个区块

- **prependContext（动态）**：L1 召回结果，每轮都变，放在用户消息前。
- **appendSystemContext（稳定）**：Persona + Scene 索引 + 工具调用指南，放在 system prompt 末尾，用 KV cache 命中。 _（待确定：放到 system prompt 末尾仍可能造成 KV cache miss，需要继续讨论。）_

```typescript
function formatPrompt(l1, persona, scenes) {
  const prepend = l1.length > 0
    ? `<relevant-memories>\n${l1.map(m => `- [${m.type}] ${m.content}`).join("\n")}\n</relevant-memories>`
    : undefined;

  const parts: string[] = [];
  if (persona) parts.push(`<user-persona>\n${persona}\n</user-persona>`);
  if (scenes.length > 0) {
    parts.push("## Scene Navigation\n*以下场景可用 tdai_read_file 读取详情*");
    parts.push(scenes.map(s => `- \`${s.path}\``).join("\n"));
  }
  parts.push(MEMORY_TOOLS_GUIDE);  // 见下文

  return { prepend, append: parts.join("\n\n") };
}
```

> 实现要点：在 `before_prompt_build` 钩子里**缓存原始用户文本**（清洁版，未注入 recall），后面 capture 阶段要用——见第 2 节。

---

## 2. 捕获（Capture）

在 agent 一轮跑完后（`agent_end` 钩子），把这一轮新增的 user/assistant 消息清洗后写回 L0。

```typescript
async function capture(client: MemoryClient, ctx: {
  sessionKey: string;
  rawMessages: any[];                  // 框架给的完整消息历史
  originalUserText: string;            // 召回阶段缓存的清洁版用户文本
  originalUserMessageCount: number;    // 召回阶段缓存的消息数
}) {
  // ① 位置切片：只保留这一轮新增的消息
  const newMessages = ctx.rawMessages.slice(ctx.originalUserMessageCount);

  // ② 提取 user/assistant，去掉 tool calls / system / 多模态噪声
  const extracted = extractUserAssistant(newMessages);

  // ③ 把被 recall 污染的用户消息换回原始版
  for (const m of extracted) {
    if (m.role === "user" && m.timestamp === newMessages[0]?.timestamp) {
      m.content = ctx.originalUserText;
      break;
    }
  }

  // ④ 文本清洗：去图片 base64、去代码块、过滤太短/纯符号
  const cleaned = extracted
    .map(m => ({ ...m, content: sanitize(m.content) }))
    .filter(m => m.content.trim().length > 5);

  if (cleaned.length === 0) return;

  // ⑤ 提交
  await client.addConversation({
    session_id: ctx.sessionKey,
    messages: cleaned.map(m => ({
      role: m.role,
      content: m.content,
      timestamp: new Date(m.timestamp).toISOString(),
    })),
  });
}
```

### 为什么要替换"被污染的用户消息"

召回阶段会往用户消息前 prepend 一段 `<relevant-memories>...</relevant-memories>`。如果不还原成原始文本就写 L0，下一轮召回就会基于这段被污染的文本去 search/embedding——形成**反馈环**，记忆会越来越乱。

### 为什么要位置切片

`agent_end` 给你的是**完整历史**，不是本轮新增。直接全发会重复写历史消息。在 `before_prompt_build` 时记一下消息数 N，`agent_end` 时 `messages.slice(N)` 就是这轮新增的。

---

## 3. 工具暴露

只用 prompt 注入的记忆是有限的。再注册三个工具让 LLM 自己查：

| 工具 | 何时用 | 实现 |
|---|---|---|
| `tdai_memory_search` | 找结构化偏好/事实 | `client.searchAtomic({ query, limit })` |
| `tdai_conversation_search` | 找原始对话片段 | `client.searchConversation({ query, limit })` |
| `tdai_read_file` | 读 persona / scene block 全文 | `client.readFile(path)` |

在 system prompt 里说清楚什么时候该调，并加上调用次数上限：

```
## 记忆工具
- tdai_memory_search：搜结构化记忆（用户偏好、规则、历史事件）
- tdai_conversation_search：搜原始对话原文
- tdai_read_file：读取场景文件（用 Scene Navigation 列出的路径）

⚠️ memory_search + conversation_search 一轮总共最多调 3 次。
```

不限次数 LLM 会反复瞎搜。

---

## 4. 错误降级

记忆服务挂了**不能挂主对话**。三条原则：

1. **召回**用 `Promise.allSettled`，单路失败不影响其它。
2. **捕获**包 try/catch，失败只记日志：
   ```typescript
   try { await capture(...); }
   catch (e) { logger.warn(`capture failed: ${e.message}`); }
   ```
3. **工具**返回错误信息字符串而不是抛异常，让 LLM 自己看到 "memory unavailable" 然后继续聊。

---

## 5. 错误处理

非零 code 抛 `TDAMError`：

```typescript
import { TDAMError } from "@tencentdb-agent-memory/memory-sdk-ts";

try {
  await client.readFile("scene_blocks/x.md");
} catch (e) {
  if (e instanceof TDAMError) {
    if (e.code === 404) {
      // 文件不存在，正常情况
    } else {
      logger.warn(`memory error code=${e.code} request_id=${e.requestId}`);
    }
  }
}
```

`requestId` 在 server 端也有日志，排障时给后端就行。

---

## 6. 性能建议

- **召回总预算 < 200ms**：三路并行后取最快返回的可用结果，超时的丢掉。
- **prompt 注入控制大小**：L1 ≤ 5 条、Scene 列表只列 path 不列内容、Persona 一份就够。让 LLM 不够用时再用工具拉详情。
- **session 粒度**：`sessionKey` 是 L0 conversation 的 partition key，长期对话用稳定 id（用户 id + 会话 id），不要每轮换。
