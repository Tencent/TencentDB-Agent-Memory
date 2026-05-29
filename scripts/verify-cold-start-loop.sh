#!/bin/bash
# ============================================================
# 验证 1: 冷启动循环 Bug 复现
# 
# 条件: 手动构造 checkpoint 状态 → last_persona_at=0, 
#        但 persona.md 存在 + scene_blocks 存在
# 预期: L3 反复触发但每次都跳过
# ============================================================

set -e

EP="https://tdai.apigateway.cd.test.polaris"
AUTH="Authorization: Bearer DQfp9PnHn+iKwON8+ipBfOCXx1ISlfXxSWWENu095ZIp"
SID="X-TDAI-Service-ID: mem-rkgqhd5z"
CT="Content-Type: application/json"
SESSION="coldstart-verify-$(date +%s)"

echo "============================================================"
echo "验证 1: 冷启动循环复现"
echo "Session: $SESSION"
echo "============================================================"
echo

# Step 1: 写入足够多的对话触发 L1 → L2 → L3 pipeline
echo "--- Step 1: 写入对话数据触发 pipeline ---"
for i in $(seq 1 10); do
  curl -sk -X POST "$EP/v2/conversation/add" -H "$CT" -H "$AUTH" -H "$SID" \
    -d "{\"session_id\":\"$SESSION\",\"messages\":[{\"role\":\"user\",\"content\":\"第${i}轮对话：测试冷启动循环\",\"timestamp\":\"2026-05-18T11:${i}:00Z\"},{\"role\":\"assistant\",\"content\":\"收到第${i}轮\",\"timestamp\":\"2026-05-18T11:${i}:05Z\"}]}" > /dev/null
  echo "  写入第 $i 轮对话"
done
echo

# Step 2: 写入 persona 和 scenario (模拟已有数据)
echo "--- Step 2: 写入 persona + scenario ---"
curl -sk -X POST "$EP/v2/persona/write" -H "$CT" -H "$AUTH" -H "$SID" \
  -d '{"content": "# Persona\n\n这是测试persona，模拟已存在的状态。"}'
echo
curl -sk -X POST "$EP/v2/scenario/write" -H "$CT" -H "$AUTH" -H "$SID" \
  -d '{"path": "test-coldstart.md", "content": "# Test Scene\n\n场景文件存在。"}'
echo
echo

# Step 3: 等待 pipeline 触发
echo "--- Step 3: 等待 60s 让 pipeline 执行 ---"
echo "  (观察容器日志看是否出现 'Trigger P2 (cold start)' 循环)"
echo "  在另一个终端执行:"
echo "  sudo docker logs -f memory-test-fixed 2>&1 | grep -E 'Trigger P2|cold start|Persona generation skipped|last_persona_at'"
echo
sleep 5

# Step 4: 检查结果
echo "--- Step 4: 读取 persona 验证 ---"
curl -sk -X POST "$EP/v2/persona/read" -H "$CT" -H "$AUTH" -H "$SID" -d '{}'
echo
echo
echo "============================================================"
echo "如果日志中反复出现:"
echo "  [trigger] Trigger P2 (cold start): scenes_processed=N, total_processed=0"
echo "  [L3] Persona generation skipped (no changes)"
echo "则 Bug 复现成功。"
echo "============================================================"
