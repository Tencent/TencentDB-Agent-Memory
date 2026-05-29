#!/usr/bin/env bash
# ============================================================
# V2 API 全接口压测脚本
# 测试所有12个 v2 端点的可用性、并发处理、Redis 状态正确性
# ============================================================
set -euo pipefail

HOST="${1:-http://localhost:8420}"
API_KEY="${2:-b9WmawnJFpb9vn0XWKDKSxF5Eaf5SeXdIHaRpShmSbgg}"
SERVICE_ID="${3:-mem-j4wjesud}"
CONCURRENCY="${4:-10}"
ROUNDS="${5:-5}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
ERRORS=""

log_ok()   { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS+1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; FAIL=$((FAIL+1)); ERRORS="${ERRORS}\n  - $1"; }
log_info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

call_api() {
  local endpoint="$1"
  local body="$2"
  local desc="$3"
  
  local resp
  resp=$(curl -s -w "\n%{http_code}" -X POST "${HOST}${endpoint}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "x-tdai-service-id: ${SERVICE_ID}" \
    -d "${body}" 2>/dev/null)
  
  local http_code
  http_code=$(echo "$resp" | tail -1)
  local body_resp
  body_resp=$(echo "$resp" | sed '$d')
  
  local code
  code=$(echo "$body_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('code',''))" 2>/dev/null || echo "parse_error")
  
  if [[ "$http_code" == "200" && "$code" == "0" ]]; then
    log_ok "$desc (HTTP=$http_code, code=$code)"
    echo "$body_resp"
    return 0
  else
    log_fail "$desc (HTTP=$http_code, code=$code, body=${body_resp:0:200})"
    return 1
  fi
}

# ============================================================
echo "=========================================="
echo " V2 API 全接口压测"
echo " Host:        $HOST"
echo " ServiceID:   $SERVICE_ID"
echo " Concurrency: $CONCURRENCY"
echo " Rounds:      $ROUNDS"
echo "=========================================="

# 0. Health check
log_info "Step 0: Health check"
HEALTH=$(curl -s "${HOST}/health" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['status'])" 2>/dev/null)
if [[ "$HEALTH" == "ok" ]]; then
  log_ok "Health check"
else
  log_fail "Health check (status=$HEALTH)"
  exit 1
fi

# ============================================================
# 1. Conversation Add (L0 写入) - 并发压测
# ============================================================
log_info "Step 1: POST /v2/conversation/add — $CONCURRENCY concurrent × $ROUNDS rounds"
TS=$(date +%s)

for round in $(seq 1 $ROUNDS); do
  pids=()
  for i in $(seq 1 $CONCURRENCY); do
    SESSION="stress-${TS}-r${round}-c${i}"
    BODY=$(cat <<EOF
{
  "instance_id": "${SERVICE_ID}",
  "session_id": "${SESSION}",
  "messages": [
    {"role": "user", "content": "压测消息 round=${round} thread=${i} 我喜欢在周末去公园跑步"},
    {"role": "assistant", "content": "跑步是很好的运动习惯！你通常跑多久？"},
    {"role": "user", "content": "一般跑30分钟左右，然后做拉伸"},
    {"role": "assistant", "content": "30分钟加拉伸是很健康的安排"}
  ]
}
EOF
)
    curl -s -o /dev/null -w "" -X POST "${HOST}/v2/conversation/add" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${API_KEY}" \
      -H "x-tdai-service-id: ${SERVICE_ID}" \
      -d "${BODY}" &
    pids+=($!)
  done
  
  # Wait for all concurrent requests
  fail_count=0
  for pid in "${pids[@]}"; do
    wait "$pid" || fail_count=$((fail_count+1))
  done
  
  if [[ $fail_count -eq 0 ]]; then
    log_ok "Round $round: $CONCURRENCY concurrent conversation/add OK"
  else
    log_fail "Round $round: $fail_count/$CONCURRENCY conversation/add failed"
  fi
done

# ============================================================
# 2. Conversation Query (L0 查询)
# ============================================================
log_info "Step 2: POST /v2/conversation/query"
SESSION_Q="stress-${TS}-r1-c1"
call_api "/v2/conversation/query" \
  "{\"instance_id\":\"${SERVICE_ID}\",\"session_id\":\"${SESSION_Q}\",\"limit\":10}" \
  "conversation/query session=${SESSION_Q}" > /dev/null || true

# ============================================================
# 3. Conversation Search (L0 搜索)
# ============================================================
log_info "Step 3: POST /v2/conversation/search"
call_api "/v2/conversation/search" \
  "{\"instance_id\":\"${SERVICE_ID}\",\"query\":\"跑步\",\"limit\":5}" \
  "conversation/search query=跑步" > /dev/null || true

# ============================================================
# 4. Conversation Delete (L0 删除)
# ============================================================
log_info "Step 4: POST /v2/conversation/delete"
call_api "/v2/conversation/delete" \
  "{\"instance_id\":\"${SERVICE_ID}\",\"session_id\":\"stress-${TS}-r${ROUNDS}-c${CONCURRENCY}\",\"ids\":[\"nonexistent-id\"]}" \
  "conversation/delete (nonexistent OK)" > /dev/null || true

# ============================================================
# 5. Atomic Add (L1 写入)
# ============================================================
log_info "Step 5: POST /v2/atomic/add — concurrent"
pids=()
for i in $(seq 1 $CONCURRENCY); do
  BODY=$(cat <<EOF
{
  "instance_id": "${SERVICE_ID}",
  "session_id": "stress-atomic-${TS}",
  "memories": [
    {"text": "用户喜欢在周末跑步 (thread=$i)", "type": "episodic", "priority": 0.8},
    {"text": "用户每次跑30分钟 (thread=$i)", "type": "episodic", "priority": 0.6}
  ]
}
EOF
)
  curl -s -o /dev/null -w "" -X POST "${HOST}/v2/atomic/add" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "x-tdai-service-id: ${SERVICE_ID}" \
    -d "${BODY}" &
  pids+=($!)
done
fail_count=0
for pid in "${pids[@]}"; do
  wait "$pid" || fail_count=$((fail_count+1))
done
if [[ $fail_count -eq 0 ]]; then
  log_ok "atomic/add: $CONCURRENCY concurrent OK"
else
  log_fail "atomic/add: $fail_count/$CONCURRENCY failed"
fi

# ============================================================
# 6. Atomic Query (L1 查询)
# ============================================================
log_info "Step 6: POST /v2/atomic/query"
call_api "/v2/atomic/query" \
  "{\"instance_id\":\"${SERVICE_ID}\",\"session_id\":\"stress-atomic-${TS}\",\"limit\":20}" \
  "atomic/query" > /dev/null || true

# ============================================================
# 7. Atomic Search (L1 搜索)
# ============================================================
log_info "Step 7: POST /v2/atomic/search"
call_api "/v2/atomic/search" \
  "{\"instance_id\":\"${SERVICE_ID}\",\"query\":\"跑步\",\"limit\":5}" \
  "atomic/search query=跑步" > /dev/null || true

# ============================================================
# 8. Atomic Delete (L1 删除)
# ============================================================
log_info "Step 8: POST /v2/atomic/delete"
call_api "/v2/atomic/delete" \
  "{\"instance_id\":\"${SERVICE_ID}\",\"ids\":[\"nonexistent-l1-id\"]}" \
  "atomic/delete (nonexistent OK)" > /dev/null || true

# ============================================================
# 9. Scenario List (L2 列表)
# ============================================================
log_info "Step 9: POST /v2/scenario/ls"
call_api "/v2/scenario/ls" \
  "{\"instance_id\":\"${SERVICE_ID}\"}" \
  "scenario/ls" > /dev/null || true

# ============================================================
# 10. Scenario Read (L2 读取)
# ============================================================
log_info "Step 10: POST /v2/scenario/read"
call_api "/v2/scenario/read" \
  "{\"instance_id\":\"${SERVICE_ID}\",\"path\":\"failover-test.md\"}" \
  "scenario/read path=failover-test.md" > /dev/null || true

# ============================================================
# 11. Scenario Write (L2 写入)
# ============================================================
log_info "Step 11: POST /v2/scenario/write"
call_api "/v2/scenario/write" \
  "{\"instance_id\":\"${SERVICE_ID}\",\"path\":\"stress-test-${TS}.md\",\"content\":\"# 压测场景\\n\\n这是压测写入的场景文件。\\n\\n## 用户偏好\\n- 周末跑步\"}" \
  "scenario/write" > /dev/null || true

# ============================================================
# 12. Scenario Delete (L2 删除)
# ============================================================
log_info "Step 12: POST /v2/scenario/rm"
call_api "/v2/scenario/rm" \
  "{\"instance_id\":\"${SERVICE_ID}\",\"path\":\"stress-test-${TS}.md\"}" \
  "scenario/rm (cleanup)" > /dev/null || true

# ============================================================
# 13. Persona Read (L3 读取)
# ============================================================
log_info "Step 13: POST /v2/persona/read"
call_api "/v2/persona/read" \
  "{\"instance_id\":\"${SERVICE_ID}\"}" \
  "persona/read" > /dev/null || true

# ============================================================
# 14. Persona Write (L3 写入)
# ============================================================
log_info "Step 14: POST /v2/persona/write"
call_api "/v2/persona/write" \
  "{\"instance_id\":\"${SERVICE_ID}\",\"content\":\"# 用户画像\\n\\n## 基本信息\\n- 喜欢跑步\\n- 周末锻炼\\n\"}" \
  "persona/write" > /dev/null || true

# ============================================================
# 15. 高并发混合读写压测
# ============================================================
log_info "Step 15: Mixed concurrent read/write stress ($((CONCURRENCY*2)) requests)"
pids=()
for i in $(seq 1 $CONCURRENCY); do
  # Write
  curl -s -o /dev/null -X POST "${HOST}/v2/conversation/add" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "x-tdai-service-id: ${SERVICE_ID}" \
    -d "{\"instance_id\":\"${SERVICE_ID}\",\"session_id\":\"mix-${TS}-${i}\",\"messages\":[{\"role\":\"user\",\"content\":\"混合压测消息 $i\"}]}" &
  pids+=($!)
  # Read
  curl -s -o /dev/null -X POST "${HOST}/v2/conversation/query" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "x-tdai-service-id: ${SERVICE_ID}" \
    -d "{\"instance_id\":\"${SERVICE_ID}\",\"session_id\":\"mix-${TS}-${i}\",\"limit\":5}" &
  pids+=($!)
done
fail_count=0
for pid in "${pids[@]}"; do
  wait "$pid" || fail_count=$((fail_count+1))
done
if [[ $fail_count -eq 0 ]]; then
  log_ok "Mixed stress: $((CONCURRENCY*2)) concurrent OK"
else
  log_fail "Mixed stress: $fail_count/$((CONCURRENCY*2)) failed"
fi

# ============================================================
# 16. Redis 状态校验
# ============================================================
log_info "Step 16: Health check + Redis state validation"
HEALTH_RESP=$(curl -s "${HOST}/health")
WORKER_TASKS=$(echo "$HEALTH_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['services']; print(f\"consumed={s['pipelineWorker']['tasksConsumed']} completed={s['pipelineWorker']['tasksCompleted']} failed={s['pipelineWorker']['tasksFailed']} deadLetter={s['pipelineWorker']['tasksDeadLettered']}\")" 2>/dev/null)
SCANNER=$(echo "$HEALTH_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['services']['timerScanner']; print(f\"scans={s['scansCompleted']} enqueued={s['tasksEnqueued']} errors={s['scanErrors']}\")" 2>/dev/null)
STATE=$(echo "$HEALTH_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['services']['stateBackend'])" 2>/dev/null)

echo "  Worker: $WORKER_TASKS"
echo "  Scanner: $SCANNER"
echo "  Redis: $STATE"

if [[ "$STATE" == "connected" ]]; then
  log_ok "Redis state: connected"
else
  log_fail "Redis state: $STATE"
fi

TASK_FAILED=$(echo "$HEALTH_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['services']['pipelineWorker']['tasksFailed'])" 2>/dev/null)
if [[ "$TASK_FAILED" == "0" ]]; then
  log_ok "No pipeline task failures"
else
  log_fail "Pipeline task failures: $TASK_FAILED"
fi

# ============================================================
# Summary
# ============================================================
echo ""
echo "=========================================="
echo " 压测结果汇总"
echo "=========================================="
echo -e " ${GREEN}PASS: $PASS${NC}"
echo -e " ${RED}FAIL: $FAIL${NC}"
if [[ $FAIL -gt 0 ]]; then
  echo -e " 失败详情:${ERRORS}"
fi
echo "=========================================="
TOTAL_MSGS=$((CONCURRENCY * ROUNDS * 4 + CONCURRENCY * 1))
echo " 总写入消息数: ~$TOTAL_MSGS (L0) + $((CONCURRENCY*2)) (L1)"
echo "=========================================="

exit $FAIL
