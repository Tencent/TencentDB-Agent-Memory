/**
 * SDK 直读测试脚本
 *
 * 验证 @tencentdb-agent-memory/memory-sdk-ts 的 MemoryFileReader 能否正确：
 *   1. 获取 STS 临时凭证（通过 Gateway /v2/cos/secret）
 *   2. 直读 persona.md
 *   3. 直读 scene_blocks/*.md
 *
 * 前置条件：
 *   - Gateway 已启动
 *   - 后端存储上有数据（先跑过 E2E pipeline 测试）
 *
 * Usage:
 *   E2E_ENDPOINT=http://127.0.0.1:8420 \
 *   E2E_API_KEY=test-key-e2e \
 *   E2E_SERVICE_ID=tdai-mem-dev001 \
 *   npx tsx tests/sdk-cos.ts
 */

import { MemoryClient, HttpTransport, createMemoryFileReader } from "@tencentdb-agent-memory/memory-sdk-ts";

const ENDPOINT = process.env.E2E_ENDPOINT || "http://127.0.0.1:8420";
const API_KEY = process.env.E2E_API_KEY || "test-key-e2e";
const SERVICE_ID = process.env.E2E_SERVICE_ID || "tdai-mem-dev001";

async function main() {
  console.log(`\n🧪 SDK 直读测试`);
  console.log(`   Endpoint:   ${ENDPOINT}`);
  console.log(`   ServiceId:  ${SERVICE_ID}`);

  // 1. 初始化 SDK
  const transport = new HttpTransport({
    endpoint: ENDPOINT,
    apiKey: API_KEY,
    serviceId: SERVICE_ID,
  });
  const client = new MemoryClient(transport);
  const fileReader = createMemoryFileReader({
    endpoint: ENDPOINT,
    apiKey: API_KEY,
    serviceId: SERVICE_ID,
  });

  console.log(`\n── Step 1: 通过 Gateway API 列举 scenario 文件`);
  const ls = await client.listScenarios({});
  console.log(`   找到 ${ls.entries.length} 个文件:`);
  for (const e of ls.entries) {
    console.log(`   - ${e.path}`);
  }

  if (ls.entries.length === 0) {
    console.log(`\n⚠️  后端存储上没有 scenario 文件，请先跑 E2E pipeline 测试生成数据。`);
    process.exit(1);
  }

  // 2. 直读 persona.md
  console.log(`\n── Step 2: 直读 persona.md`);
  try {
    const persona = await fileReader.read("persona.md");
    console.log(`   ✅ 读取成功 (${persona.length} chars)`);
    console.log(`   内容前 200 字: ${persona.slice(0, 200)}...`);
  } catch (err) {
    console.log(`   ❌ 读取失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. 直读第一个 scene block
  const firstScene = ls.entries[0];
  const cosPath = `scene_blocks/${firstScene.path}`;
  console.log(`\n── Step 3: 直读 ${cosPath}`);
  try {
    const content = await fileReader.read(cosPath);
    console.log(`   ✅ 读取成功 (${content.length} chars)`);
    console.log(`   内容前 200 字: ${content.slice(0, 200)}...`);
  } catch (err) {
    console.log(`   ❌ 读取失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. 对比：通过 Gateway API 读同一个文件
  console.log(`\n── Step 4: 对比 — Gateway API 读同一个文件`);
  try {
    const apiResult = await client.readScenario({ path: firstScene.path });
    console.log(`   ✅ Gateway API 读取成功 (${apiResult.content.length} chars)`);
    console.log(`   内容前 200 字: ${apiResult.content.slice(0, 200)}...`);
  } catch (err) {
    console.log(`   ❌ Gateway API 读取失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`  ✅ SDK 直读测试完成`);
  console.log(`${"═".repeat(50)}\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
