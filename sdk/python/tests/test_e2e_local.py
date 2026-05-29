#!/usr/bin/env python3
"""
E2E test script for TencentDB Agent Memory v2 SDK.
Tests all 14 endpoints against a local or remote memory service.

Usage:
    python test_e2e_local.py

Environment variables (optional):
    TDAI_ENDPOINT   default: http://127.0.0.1:8420
    TDAI_API_KEY    default: DQfp9PnHn+iKwON8+ipBfOCXx1ISlfXxSWWENu095ZIp
    TDAI_SERVICE_ID default: mem-rkgqhd5z
"""

from __future__ import annotations

import os
import sys
import uuid

# Ensure sdk/python is on path so we can import tencentdb_agent_memory without pip install
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tencentdb_agent_memory import MemoryClient, TDAMError

# httpx may raise HTTPStatusError for 4xx/5xx when the stub does not unwrap envelopes
try:
    from httpx import HTTPStatusError
except ImportError:
    HTTPStatusError = Exception

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ENDPOINT = os.environ.get("TDAI_ENDPOINT", "http://127.0.0.1:8420")
API_KEY = os.environ.get("TDAI_API_KEY", "DQfp9PnHn+iKwON8+ipBfOCXx1ISlfXxSWWENu095ZIp")
SERVICE_ID = os.environ.get("TDAI_SERVICE_ID", "mem-rkgqhd5z")

# Unique session per run to avoid collisions
SESSION_ID = f"sdk-test-{uuid.uuid4().hex[:8]}"


def log(msg: str) -> None:
    print(f"[TEST] {msg}")


def main() -> int:
    log(f"endpoint={ENDPOINT} service_id={SERVICE_ID} session={SESSION_ID}")

    client = MemoryClient(
        endpoint=ENDPOINT,
        api_key=API_KEY,
        service_id=SERVICE_ID,
    )

    errors = 0

    # =====================================================================
    # L0 Conversation
    # =====================================================================
    try:
        log("--- L0: add_conversation ---")
        result = client.add_conversation(
            session_id=SESSION_ID,
            messages=[
                {"role": "user", "content": "你好，帮我查一下数据库慢查询", "timestamp": "2026-05-15T09:00:00Z"},
                {"role": "assistant", "content": "好的，请问是哪个实例？", "timestamp": "2026-05-15T09:00:05Z"},
                {"role": "user", "content": "实例 ID 是 mem-rkgqhd5z", "timestamp": "2026-05-15T09:00:10Z"},
            ],
        )
        log(f"add_conversation OK: accepted={result.get('accepted_ids', [])}")
    except (TDAMError, HTTPStatusError) as e:
        msg = e.message if hasattr(e, "message") else str(e)
        log(f"add_conversation FAILED: {msg}")
        errors += 1

    try:
        log("--- L0: query_conversation ---")
        result = client.query_conversation(session_id=SESSION_ID, limit=10, offset=0)
        msgs = result.get("messages", [])
        log(f"query_conversation OK: total={result.get('total', 0)} returned={len(msgs)}")
        for m in msgs:
            log(f"  [{m.get('role', '?')}] {m.get('content', '')[:60]}...")
    except (TDAMError, HTTPStatusError) as e:
        msg = e.message if hasattr(e, "message") else str(e)
        log(f"query_conversation FAILED: {msg}")
        errors += 1

    try:
        log("--- L0: search_conversation ---")
        result = client.search_conversation(query="数据库慢查询", limit=5, session_id=SESSION_ID)
        msgs = result.get("messages", [])
        log(f"search_conversation OK: returned={len(msgs)}")
        for m in msgs:
            log(f"  score={m.get('score', 0):.3f} [{m.get('role', '?')}] {m.get('content', '')[:60]}...")
    except (TDAMError, HTTPStatusError) as e:
        msg = e.message if hasattr(e, "message") else str(e)
        log(f"search_conversation FAILED: {msg}")
        errors += 1

    # =====================================================================
    # L1 Atomic
    # =====================================================================
    atomic_ids: list[str] = []
    try:
        log("--- L1: add_atomic ---")
        result = client.add_atomic(type="note", content="用户偏好使用 PostgreSQL 数据库")
        log(f"add_atomic OK: {result}")
        if "id" in result:
            atomic_ids.append(result["id"])
    except (TDAMError, HTTPStatusError) as e:
        msg = e.message if hasattr(e, "message") else str(e)
        log(f"add_atomic FAILED: {msg}")
        errors += 1

    try:
        log("--- L1: query_atomic ---")
        result = client.query_atomic(type="note", limit=10, offset=0)
        log(f"query_atomic OK: total={result.get('total', 0)}")
    except (TDAMError, HTTPStatusError) as e:
        msg = e.message if hasattr(e, "message") else str(e)
        log(f"query_atomic FAILED: {msg}")
        errors += 1

    try:
        log("--- L1: search_atomic ---")
        result = client.search_atomic(query="PostgreSQL", limit=5)
        log(f"search_atomic OK: returned={len(result.get('messages', []))}")
    except (TDAMError, HTTPStatusError) as e:
        msg = e.message if hasattr(e, "message") else str(e)
        log(f"search_atomic FAILED: {msg}")
        errors += 1

    # =====================================================================
    # L2 Scenario
    # =====================================================================
    scenario_path = f"test-scenario-{uuid.uuid4().hex[:6]}.md"
    try:
        log("--- L2: write_scenario ---")
        result = client.write_scenario(path=scenario_path, content="# Test Scenario\n\nThis is a test.")
        log(f"write_scenario OK: {result}")
    except (TDAMError, HTTPStatusError) as e:
        msg = e.message if hasattr(e, "message") else str(e)
        log(f"write_scenario FAILED: {msg}")
        errors += 1

    try:
        log("--- L2: list_scenarios ---")
        result = client.list_scenarios(limit=20, offset=0)
        log(f"list_scenarios OK: total={result.get('total', 0)}")
    except (TDAMError, HTTPStatusError) as e:
        msg = e.message if hasattr(e, "message") else str(e)
        log(f"list_scenarios FAILED: {msg}")
        errors += 1

    try:
        log("--- L2: read_scenario ---")
        result = client.read_scenario(path=scenario_path)
        log(f"read_scenario OK: content={result.get('content', '')[:80]}...")
    except (TDAMError, HTTPStatusError) as e:
        msg = e.message if hasattr(e, "message") else str(e)
        log(f"read_scenario FAILED: {msg}")
        errors += 1

    try:
        log("--- L2: rm_scenario ---")
        result = client.rm_scenario(path=scenario_path)
        log(f"rm_scenario OK: {result}")
    except (TDAMError, HTTPStatusError) as e:
        msg = e.message if hasattr(e, "message") else str(e)
        log(f"rm_scenario FAILED: {msg}")
        errors += 1

    # =====================================================================
    # L3 Persona
    # =====================================================================
    try:
        log("--- L3: write_persona ---")
        result = client.write_persona(content="# Persona\n\n乐于助人、精通数据库优化的 AI 助手。")
        log(f"write_persona OK: {result}")
    except (TDAMError, HTTPStatusError) as e:
        msg = e.message if hasattr(e, "message") else str(e)
        log(f"write_persona FAILED: {msg}")
        errors += 1

    try:
        log("--- L3: read_persona ---")
        result = client.read_persona()
        log(f"read_persona OK: content={result.get('content', '')[:80]}...")
    except (TDAMError, HTTPStatusError) as e:
        msg = e.message if hasattr(e, "message") else str(e)
        log(f"read_persona FAILED: {msg}")
        errors += 1

    # =====================================================================
    # Cleanup
    # =====================================================================
    try:
        log("--- Cleanup: delete_conversation (by session) ---")
        result = client.delete_conversation(session_id=SESSION_ID)
        log(f"delete_conversation OK: deleted_count={result.get('deleted_count', 0)}")
    except (TDAMError, HTTPStatusError) as e:
        msg = e.message if hasattr(e, "message") else str(e)
        log(f"delete_conversation FAILED: {msg}")
        errors += 1

    if atomic_ids:
        try:
            log("--- Cleanup: delete_atomic ---")
            result = client.delete_atomic(ids=atomic_ids)
            log(f"delete_atomic OK: {result}")
        except (TDAMError, HTTPStatusError) as e:
            msg = e.message if hasattr(e, "message") else str(e)
            log(f"delete_atomic FAILED: {msg}")
            errors += 1

    client.close()

    log("=" * 60)
    if errors == 0:
        log("ALL TESTS PASSED")
        return 0
    else:
        log(f"FAILED: {errors} error(s)")
        return 1


if __name__ == "__main__":
    sys.exit(main())
