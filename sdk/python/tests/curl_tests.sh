#!/usr/bin/env bash
# TDAI Memory v2 API — curl test scripts (local 127.0.0.1:8420)
# Usage: source ./curl_tests.sh && test_l0_add

ENDPOINT="http://127.0.0.1:8420"
API_KEY="DQfp9PnHn+iKwON8+ipBfOCXx1ISlfXxSWWENu095ZIp"
SERVICE_ID="mem-rkgqhd5z"
SESSION_ID="curl-test-$(date +%s)"

HDRS=(
  -H "Authorization: Bearer ${API_KEY}"
  -H "X-tdai-service-id: ${SERVICE_ID}"
  -H "Content-Type: application/json"
)

# ---------------------------------------------------------------------------
# L0 Conversation
# ---------------------------------------------------------------------------

test_l0_add() {
  echo "=== POST /v2/conversation/add ==="
  curl -s -X POST "${ENDPOINT}/v2/conversation/add" "${HDRS[@]}" \
    -d '{
      "session_id": "'"${SESSION_ID}"'",
      "messages": [
        {"role": "user", "content": "你好，帮我查一下数据库慢查询", "timestamp": "2026-05-15T09:00:00Z"},
        {"role": "assistant", "content": "好的，请问是哪个实例？", "timestamp": "2026-05-15T09:00:05Z"}
      ]
    }' | python3 -m json.tool 2>/dev/null || cat
  echo
}

test_l0_query() {
  echo "=== POST /v2/conversation/query ==="
  curl -s -X POST "${ENDPOINT}/v2/conversation/query" "${HDRS[@]}" \
    -d '{
      "session_id": "'"${SESSION_ID}"'",
      "limit": 10,
      "offset": 0
    }' | python3 -m json.tool 2>/dev/null || cat
  echo
}

test_l0_search() {
  echo "=== POST /v2/conversation/search ==="
  curl -s -X POST "${ENDPOINT}/v2/conversation/search" "${HDRS[@]}" \
    -d '{
      "query": "数据库慢查询",
      "limit": 5,
      "session_id": "'"${SESSION_ID}"'"
    }' | python3 -m json.tool 2>/dev/null || cat
  echo
}

test_l0_delete() {
  echo "=== POST /v2/conversation/delete (by session) ==="
  curl -s -X POST "${ENDPOINT}/v2/conversation/delete" "${HDRS[@]}" \
    -d '{
      "session_id": "'"${SESSION_ID}"'"
    }' | python3 -m json.tool 2>/dev/null || cat
  echo
}

# ---------------------------------------------------------------------------
# L1 Atomic
# ---------------------------------------------------------------------------

test_l1_add() {
  echo "=== POST /v2/atomic/add ==="
  curl -s -X POST "${ENDPOINT}/v2/atomic/add" "${HDRS[@]}" \
    -d '{
      "type": "note",
      "content": "用户偏好使用 PostgreSQL 数据库"
    }' | python3 -m json.tool 2>/dev/null || cat
  echo
}

test_l1_query() {
  echo "=== POST /v2/atomic/query ==="
  curl -s -X POST "${ENDPOINT}/v2/atomic/query" "${HDRS[@]}" \
    -d '{
      "type": "note",
      "limit": 10,
      "offset": 0
    }' | python3 -m json.tool 2>/dev/null || cat
  echo
}

test_l1_search() {
  echo "=== POST /v2/atomic/search ==="
  curl -s -X POST "${ENDPOINT}/v2/atomic/search" "${HDRS[@]}" \
    -d '{
      "query": "PostgreSQL",
      "limit": 5
    }' | python3 -m json.tool 2>/dev/null || cat
  echo
}

# ---------------------------------------------------------------------------
# L2 Scenario
# ---------------------------------------------------------------------------

test_l2_write() {
  echo "=== POST /v2/scenario/write ==="
  curl -s -X POST "${ENDPOINT}/v2/scenario/write" "${HDRS[@]}" \
    -d '{
      "path": "test-scenario.md",
      "content": "# Test Scenario\n\nThis is a test."
    }' | python3 -m json.tool 2>/dev/null || cat
  echo
}

test_l2_ls() {
  echo "=== POST /v2/scenario/ls ==="
  curl -s -X POST "${ENDPOINT}/v2/scenario/ls" "${HDRS[@]}" \
    -d '{
      "limit": 20,
      "offset": 0
    }' | python3 -m json.tool 2>/dev/null || cat
  echo
}

test_l2_read() {
  echo "=== POST /v2/scenario/read ==="
  curl -s -X POST "${ENDPOINT}/v2/scenario/read" "${HDRS[@]}" \
    -d '{
      "path": "test-scenario.md"
    }' | python3 -m json.tool 2>/dev/null || cat
  echo
}

test_l2_rm() {
  echo "=== POST /v2/scenario/rm ==="
  curl -s -X POST "${ENDPOINT}/v2/scenario/rm" "${HDRS[@]}" \
    -d '{
      "path": "test-scenario.md"
    }' | python3 -m json.tool 2>/dev/null || cat
  echo
}

# ---------------------------------------------------------------------------
# L3 Persona
# ---------------------------------------------------------------------------

test_l3_write() {
  echo "=== POST /v2/persona/write ==="
  curl -s -X POST "${ENDPOINT}/v2/persona/write" "${HDRS[@]}" \
    -d '{
      "content": "# Persona\n\n乐于助人、精通数据库优化的 AI 助手。"
    }' | python3 -m json.tool 2>/dev/null || cat
  echo
}

test_l3_read() {
  echo "=== POST /v2/persona/read ==="
  curl -s -X POST "${ENDPOINT}/v2/persona/read" "${HDRS[@]}" \
    -d '{}' | python3 -m json.tool 2>/dev/null || cat
  echo
}

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

test_health() {
  echo "=== GET /health ==="
  curl -s "${ENDPOINT}/health" | python3 -m json.tool 2>/dev/null || cat
  echo
}

# ---------------------------------------------------------------------------
# Run all
# ---------------------------------------------------------------------------

test_all() {
  test_health
  test_l0_add
  test_l0_query
  test_l0_search
  test_l1_add
  test_l1_query
  test_l1_search
  test_l2_write
  test_l2_ls
  test_l2_read
  test_l3_write
  test_l3_read
  test_l2_rm
  test_l0_delete
}
