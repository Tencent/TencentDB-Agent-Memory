#!/usr/bin/env python3
"""
E2E test against the formal API Gateway (not local container).
Endpoint: https://tdai.apigateway.cd.test.polaris
"""

import os
import sys
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx
from tencentdb_agent_memory import MemoryClient, TDAMError
from tencentdb_agent_memory._http import HttpStub

try:
    from httpx import HTTPStatusError
except ImportError:
    HTTPStatusError = Exception

ENDPOINT = "https://tdai.apigateway.cd.test.polaris"
API_KEY = "DQfp9PnHn+iKwON8+ipBfOCXx1ISlfXxSWWENu095ZIp"
SERVICE_ID = "mem-rkgqhd5z"
SESSION_ID = f"gateway-test-{uuid.uuid4().hex[:8]}"


def log(msg: str) -> None:
    print(f"[TEST] {msg}")


def main() -> int:
    log(f"endpoint={ENDPOINT} service_id={SERVICE_ID} session={SESSION_ID}")

    # Bypass self-signed certificate verification for test environment
    http_client = httpx.Client(timeout=30, verify=False)
    client = MemoryClient(
        endpoint=ENDPOINT,
        api_key=API_KEY,
        service_id=SERVICE_ID,
        stub=HttpStub(ENDPOINT, API_KEY, SERVICE_ID, client=http_client),
    )
    errors = 0

    # L0
    try:
        log("--- L0: add_conversation ---")
        r = client.add_conversation(
            session_id=SESSION_ID,
            messages=[
                {"role": "user", "content": "Gateway 测试：你好", "timestamp": "2026-05-15T09:00:00Z"},
                {"role": "assistant", "content": "Gateway 测试：你好！", "timestamp": "2026-05-15T09:00:05Z"},
            ],
        )
        log(f"OK: accepted={r.get('accepted_ids', [])}")
    except (TDAMError, HTTPStatusError) as e:
        log(f"FAILED: {e.message if hasattr(e, 'message') else str(e)}")
        errors += 1

    try:
        log("--- L0: query_conversation ---")
        r = client.query_conversation(session_id=SESSION_ID, limit=10)
        log(f"OK: total={r.get('total', 0)}")
    except (TDAMError, HTTPStatusError) as e:
        log(f"FAILED: {e.message if hasattr(e, 'message') else str(e)}")
        errors += 1

    try:
        log("--- L0: search_conversation ---")
        r = client.search_conversation(query="Gateway 测试", limit=5, session_id=SESSION_ID)
        log(f"OK: returned={len(r.get('messages', []))}")
    except (TDAMError, HTTPStatusError) as e:
        log(f"FAILED: {e.message if hasattr(e, 'message') else str(e)}")
        errors += 1

    # L1
    try:
        log("--- L1: add_atomic ---")
        r = client.add_atomic(type="note", content="Gateway 环境测试数据")
        log(f"OK: id={r.get('id')}")
    except (TDAMError, HTTPStatusError) as e:
        log(f"FAILED: {e.message if hasattr(e, 'message') else str(e)}")
        errors += 1

    try:
        log("--- L1: query_atomic ---")
        r = client.query_atomic(type="note", limit=10)
        log(f"OK: total={r.get('total', 0)}")
    except (TDAMError, HTTPStatusError) as e:
        log(f"FAILED: {e.message if hasattr(e, 'message') else str(e)}")
        errors += 1

    # L2 / L3 (service mode — should work if Gateway has valid COS creds)
    scenario_path = f"gateway-test-{uuid.uuid4().hex[:6]}.md"
    try:
        log("--- L2: write_scenario ---")
        r = client.write_scenario(path=scenario_path, content="# Gateway Test\n\nFrom formal env.")
        log(f"OK: {r}")
    except (TDAMError, HTTPStatusError) as e:
        log(f"FAILED: {e.message if hasattr(e, 'message') else str(e)}")
        errors += 1

    try:
        log("--- L2: read_scenario ---")
        r = client.read_scenario(path=scenario_path)
        log(f"OK: content={r.get('content', '')[:60]}...")
    except (TDAMError, HTTPStatusError) as e:
        log(f"FAILED: {e.message if hasattr(e, 'message') else str(e)}")
        errors += 1

    try:
        log("--- L3: write_persona ---")
        r = client.write_persona(content="# Persona\n\nGateway env persona.")
        log(f"OK: {r}")
    except (TDAMError, HTTPStatusError) as e:
        log(f"FAILED: {e.message if hasattr(e, 'message') else str(e)}")
        errors += 1

    try:
        log("--- L3: read_persona ---")
        r = client.read_persona()
        log(f"OK: content={r.get('content', '')[:60]}...")
    except (TDAMError, HTTPStatusError) as e:
        log(f"FAILED: {e.message if hasattr(e, 'message') else str(e)}")
        errors += 1

    # Cleanup
    try:
        log("--- Cleanup: delete_conversation ---")
        r = client.delete_conversation(session_id=SESSION_ID)
        log(f"OK: deleted={r.get('deleted_count', 0)}")
    except (TDAMError, HTTPStatusError) as e:
        log(f"FAILED: {e.message if hasattr(e, 'message') else str(e)}")
        errors += 1

    client.close()

    log("=" * 60)
    if errors == 0:
        log("ALL TESTS PASSED")
    else:
        log(f"FAILED: {errors} error(s)")
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
