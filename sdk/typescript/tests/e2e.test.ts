/**
 * SDK E2E Test — 打远端验证所有 v2 API 接口可用性
 *
 * 环境变量（从 .env 读或手动 export）：
 *   E2E_ENDPOINT    — Gateway 地址
 *   E2E_API_KEY     — Bearer Token
 *   E2E_SERVICE_ID  — x-tdai-service-id
 *
 * 运行：
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx tests/e2e.test.ts
 */

import { MemoryClient } from "../src/client.js";
import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env from project root
config({ path: resolve(import.meta.dirname ?? __dirname, "..", "..", "..", ".env") });

const ENDPOINT = process.env.E2E_ENDPOINT || "http://127.0.0.1:8420";
const API_KEY = process.env.E2E_API_KEY || "test-key";
const SERVICE_ID = process.env.E2E_SERVICE_ID || "test-service";
const ENABLE_DELETE = process.env.E2E_ENABLE_DELETE === "1";

const TS = Date.now();
const SESSION_ID = `sdk-e2e-${TS}`;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ❌ ${msg}`);
  }
}

function section(name: string) {
  console.log(`\n━━━ ${name} ━━━`);
}

async function main() {
  console.log(`\n🧪 TencentDB Agent Memory TypeScript SDK E2E`);
  console.log(`   Endpoint:   ${ENDPOINT}`);
  console.log(`   ServiceId:  ${SERVICE_ID}`);
  console.log(`   Session:    ${SESSION_ID}`);

  const client = new MemoryClient({
    endpoint: ENDPOINT,
    apiKey: API_KEY,
    serviceId: SERVICE_ID,
  });

  // ════════════════════════════════════════════
  // L0 Conversation
  // ════════════════════════════════════════════
  section("L0 Conversation");

  // add
  const addResult = await client.addConversation({
    session_id: SESSION_ID,
    messages: [
      { role: "user", content: "SDK E2E 测试消息 1" },
      { role: "assistant", content: "收到了，这是回复" },
      { role: "user", content: "SDK E2E 测试消息 2" },
    ],
  });
  assert(addResult.total_count === 3, `conversation/add: total_count=${addResult.total_count}`);
  assert(addResult.accepted_ids.length === 3, `conversation/add: accepted_ids=${addResult.accepted_ids.length}`);

  // query
  const queryResult = await client.queryConversation({ session_id: SESSION_ID, limit: 10 });
  assert(queryResult.total >= 3, `conversation/query: total=${queryResult.total}`);
  assert(queryResult.messages.length >= 3, `conversation/query: messages=${queryResult.messages.length}`);

  // search
  const searchResult = await client.searchConversation({ query: "SDK E2E 测试", limit: 5 });
  assert(searchResult.messages.length > 0, `conversation/search: hits=${searchResult.messages.length}`);

  // delete (by session_id) — only when E2E_ENABLE_DELETE=1
  if (ENABLE_DELETE) {
    const delResult = await client.deleteConversation({ session_id: SESSION_ID });
    assert(delResult.deleted_count >= 3, `conversation/delete: deleted_count=${delResult.deleted_count}`);

    // verify delete
    const afterDel = await client.queryConversation({ session_id: SESSION_ID });
    assert(afterDel.total === 0, `conversation/query after delete: total=${afterDel.total}`);
  } else {
    console.log(`  ℹ️  跳过 conversation/delete (E2E_ENABLE_DELETE!=1)`);
  }
  // ════════════════════════════════════════════
  // L1 Atomic
  // ════════════════════════════════════════════
  section("L1 Atomic");

  // query (list existing)
  const atomicQuery = await client.queryAtomic({ limit: 5 });
  assert(atomicQuery.total >= 0, `atomic/query: total=${atomicQuery.total}`);

  // search
  const atomicSearch = await client.searchAtomic({ query: "测试", limit: 5 });
  assert(Array.isArray(atomicSearch.items), `atomic/search: items is array (len=${atomicSearch.items.length})`);

  // update + delete (if we have items)
  if (atomicQuery.items.length > 0) {
    const targetId = atomicQuery.items[0].id;
    const originalContent = atomicQuery.items[0].content;
    const updatedContent = `${originalContent} [SDK E2E ${TS}]`;

    const updateResult = await client.updateAtomic({
      id: targetId,
      content: updatedContent,
    });
    assert(!!updateResult.updated_at, `atomic/update: updated_at=${updateResult.updated_at}`);

    // read back to verify timestamp marker (wait for index consistency)
    await new Promise(r => setTimeout(r, 2000));
    const afterUpdate = await client.queryAtomic({ limit: 50 });
    const found = afterUpdate.items.find(i => i.id === targetId);
    if (found) {
      console.log(`  🔍 atomic verify: id=${found.id}, content="${found.content.slice(0, 100)}"`);
    } else {
      console.log(`  🔍 atomic verify: id=${targetId} NOT FOUND in ${afterUpdate.items.length} items`);
    }
    assert(!!found && found.content.includes(`[SDK E2E ${TS}]`), `atomic/update verify: marker [SDK E2E ${TS}] found`);

    // revert
    await client.updateAtomic({ id: targetId, content: originalContent });
    console.log(`  ℹ️  已还原 atomic content`);

    // delete (only if E2E_ENABLE_DELETE=1 and we have >=2 items to safely delete the last one)
    if (ENABLE_DELETE && atomicQuery.items.length >= 2) {
      const lastItem = atomicQuery.items[atomicQuery.items.length - 1];
      const delResult = await client.deleteAtomic({ ids: [lastItem.id] });
      assert(delResult.deleted_count >= 1, `atomic/delete: deleted_count=${delResult.deleted_count}`);

      // verify gone
      await new Promise(r => setTimeout(r, 2000));
      const afterAtomicDel = await client.queryAtomic({ limit: 50 });
      const stillExists = afterAtomicDel.items.some(i => i.id === lastItem.id);
      assert(!stillExists, `atomic/delete verify: id=${lastItem.id} not found after delete`);
    } else if (!ENABLE_DELETE) {
      console.log(`  ℹ️  跳过 atomic/delete (E2E_ENABLE_DELETE!=1)`);
    } else {
      console.log(`  ℹ️  L1 记忆不足 2 条，跳过 atomic/delete`);
    }
  } else {
    console.log(`  ℹ️  暂无 L1 记忆，跳过 update/delete`);
  }

  // ════════════════════════════════════════════
  // L2 Scenario
  // ════════════════════════════════════════════
  section("L2 Scenario");

  // ls
  const lsResult = await client.listScenarios();
  assert(lsResult.total >= 0, `scenario/ls: total=${lsResult.total}`);
  assert(Array.isArray(lsResult.entries), `scenario/ls: entries is array`);

  if (lsResult.entries.length > 0) {
    const firstFile = lsResult.entries.find(e => !e.path.endsWith("/"));
    if (firstFile) {
      // read
      const readResult = await client.readScenario({ path: firstFile.path });
      assert(!!readResult.content, `scenario/read "${firstFile.path}": content.length=${readResult.content.length}`);
      assert(!!readResult.updated_at, `scenario/read: has updated_at`);

      // write (append marker, then revert)
      const marker = `\n<!-- SDK E2E ${TS} -->`;
      const newContent = readResult.content.replace(/^-----META-START-----[\s\S]*?-----META-END-----\n*/, "") + marker;
      const writeResult = await client.writeScenario({ path: firstFile.path, content: newContent, summary: "SDK E2E test" });
      assert(!!writeResult.updated_at, `scenario/write: updated_at=${writeResult.updated_at}`);

      // read back & verify
      const verifyRead = await client.readScenario({ path: firstFile.path });
      assert(verifyRead.content.includes("SDK E2E"), `scenario/read verify: marker found`);
    }
  } else {
    console.log(`  ℹ️  暂无 scenario 文件，跳过 read/write`);
  }

  // ════════════════════════════════════════════
  // L3 Core (Persona)
  // ════════════════════════════════════════════
  section("L3 Core");

  // read
  const coreRead = await client.readCore();
  if (coreRead.content) {
    assert(coreRead.content.length > 0, `core/read: content.length=${coreRead.content.length}`);

    // write (append marker)
    const coreMarker = `\n\n<!-- SDK E2E marker ${TS} -->`;
    const coreWriteResult = await client.writeCore({ content: coreRead.content + coreMarker });
    assert(!!coreWriteResult.updated_at, `core/write: updated_at=${coreWriteResult.updated_at}`);

    // read back
    const coreVerify = await client.readCore();
    assert(coreVerify.content.includes("SDK E2E marker"), `core/read verify: marker found`);
  } else {
    console.log(`  ℹ️  暂无 persona，跳过 core/write`);
  }

  // ════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════
  const total = passed + failed;
  console.log("");
  if (failed === 0) {
    console.log(`\x1b[42m\x1b[30m                                                  \x1b[0m`);
    console.log(`\x1b[42m\x1b[30m   ✅  ALL ${total} TESTS PASSED                        \x1b[0m`);
    console.log(`\x1b[42m\x1b[30m                                                  \x1b[0m`);
  } else {
    console.log(`\x1b[41m\x1b[37m                                                  \x1b[0m`);
    console.log(`\x1b[41m\x1b[37m   ❌  ${failed} / ${total} TESTS FAILED                      \x1b[0m`);
    console.log(`\x1b[41m\x1b[37m                                                  \x1b[0m`);
    console.log("");
    console.log(`  \x1b[31m┌─── Failures ───────────────────────────────┐\x1b[0m`);
    for (const f of failures) {
      console.log(`  \x1b[31m│\x1b[0m  • ${f}`);
    }
    console.log(`  \x1b[31m└────────────────────────────────────────────┘\x1b[0m`);
  }
  console.log("");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
