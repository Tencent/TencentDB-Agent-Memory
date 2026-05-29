#!/bin/bash
# 常温测试脚本：每30秒通过LLM生成对话写入，持续验证 L0→L1→L3 有效性
# Usage: bash warm-test-loop.sh [rounds] (default: infinite)

set -uo pipefail

APIG_URL="${APIG_URL:-https://tdai.apigateway.cd.test.polaris/v2}"
INSTANCE="${INSTANCE:-mem-0294jqv7}"
API_KEY="${API_KEY:?Please set API_KEY env var}"
LLM_URL="${LLM_URL:-https://tokenhub.tencentmaas.com/v1/chat/completions}"
LLM_KEY="${LLM_KEY:?Please set LLM_KEY env var}"
LLM_MODEL="${LLM_MODEL:-minimax-m2.7}"
INTERVAL=30
MAX_ROUNDS=${1:-0}  # 0 = infinite

ROUND=0
PASS=0
FAIL=0

echo "=========================================="
echo " 常温测试 - 每${INTERVAL}秒一轮 (LLM生成对话)"
echo " APIG: ${APIG_URL}"
echo " Instance: ${INSTANCE}"
echo " Started: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="
echo ""

cleanup() {
  echo ""
  echo "=========================================="
  echo " 测试结束 ($(date '+%H:%M:%S'))"
  echo " 总轮次: ${ROUND}"
  echo " PASS: ${PASS}"
  echo " FAIL: ${FAIL}"
  echo "=========================================="
  exit 0
}
trap cleanup SIGINT SIGTERM

generate_conversation() {
  local round=$1
  # 用LLM生成随机对话（3轮user/assistant）
  local prompt="请生成一段模拟用户和AI助手的对话（3轮，共6条消息）。用户在自我介绍中包含：姓名、年龄、职业、工作地点、技术栈或专业领域、业余爱好。每轮对话要有具体细节（数字、地名、品牌等）。第${round}次生成请确保内容独特不重复。

严格按以下JSON格式输出，不要输出任何其他内容：
[{\"role\":\"user\",\"content\":\"...\"},{\"role\":\"assistant\",\"content\":\"...\"},{\"role\":\"user\",\"content\":\"...\"},{\"role\":\"assistant\",\"content\":\"...\"},{\"role\":\"user\",\"content\":\"...\"},{\"role\":\"assistant\",\"content\":\"...\"}]"

  local resp
  resp=$(curl -s --connect-timeout 15 --max-time 30 "${LLM_URL}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${LLM_KEY}" \
    -d "{\"model\":\"${LLM_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":$(echo "$prompt" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")}],\"max_tokens\":800,\"temperature\":0.9}" 2>/dev/null)

  # 提取content并解析JSON array
  echo "$resp" | python3 -c "
import sys,json,re
try:
    d=json.load(sys.stdin)
    content=d['choices'][0]['message']['content']
    # 提取JSON数组
    match=re.search(r'\[[\s\S]*\]', content)
    if match:
        msgs=json.loads(match.group())
        if len(msgs)>=6:
            print(json.dumps(msgs[:6], ensure_ascii=False))
        else:
            print('ERROR:not_enough_msgs')
    else:
        print('ERROR:no_json_array')
except Exception as e:
    print(f'ERROR:{e}')
" 2>/dev/null
}

while true; do
  ROUND=$((ROUND + 1))
  if [ "${MAX_ROUNDS}" -gt 0 ] && [ "${ROUND}" -gt "${MAX_ROUNDS}" ]; then
    break
  fi

  TS=$(date +%s)
  SESSION="warm-${TS}-r${ROUND}"

  echo "[Round ${ROUND}] $(date '+%H:%M:%S') session=${SESSION}"

  # 1. LLM 生成对话
  echo "  生成对话..."
  MESSAGES=$(generate_conversation ${ROUND})

  if [[ "$MESSAGES" == ERROR:* ]]; then
    echo "  ❌ LLM生成失败: ${MESSAGES}"
    FAIL=$((FAIL + 1))
    sleep ${INTERVAL}
    continue
  fi

  # 2. 写入 L0
  RESP=$(curl -sk -X POST "${APIG_URL}/conversation/add" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "X-TDAI-Service-ID: ${INSTANCE}" \
    -d "{\"session_id\":\"${SESSION}\",\"messages\":${MESSAGES}}" 2>/dev/null)

  L0_CODE=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('code','err'))" 2>/dev/null || echo "parse_err")
  L0_COUNT=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',{}).get('accepted_ids',[])))" 2>/dev/null || echo "0")

  if [ "$L0_CODE" = "0" ]; then
    echo "  ✓ L0写入: ${L0_COUNT}条"
  else
    echo "  ❌ L0写入失败: code=${L0_CODE}"
    FAIL=$((FAIL + 1))
    sleep ${INTERVAL}
    continue
  fi

  # 3. 验证 L1 total 递增
  L1_BEFORE=$(curl -sk -X POST "${APIG_URL}/atomic/query" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "X-TDAI-Service-ID: ${INSTANCE}" \
    -d "{\"limit\":1}" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('total',0))" 2>/dev/null || echo "0")
  echo "  L1 total(before): ${L1_BEFORE}"

  # 4. 验证 Persona 存在
  PERSONA_LEN=$(curl -sk -X POST "${APIG_URL}/persona/read" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "X-TDAI-Service-ID: ${INSTANCE}" \
    -d '{}' 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',{}).get('content','')))" 2>/dev/null || echo "0")
  echo "  L3 Persona长度: ${PERSONA_LEN}"

  # 5. Health check
  HEALTH=$(curl -sk "${APIG_URL}/../health" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null || echo "unknown")

  if [ "$L0_CODE" = "0" ] && [ "$L0_COUNT" -ge 4 ]; then
    PASS=$((PASS + 1))
    echo "  ✓ PASS (L0=${L0_COUNT}, L1_total=${L1_BEFORE}, Persona=${PERSONA_LEN})"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ FAIL"
  fi

  echo "  [累计] PASS=${PASS} FAIL=${FAIL} | 等待${INTERVAL}s..."
  echo ""
  sleep ${INTERVAL}
done

cleanup
