"""
SDK E2E Test — 打远端验证所有 v2 API 接口可用性

环境变量（从 .env 读或手动 export）：
  E2E_ENDPOINT    — Gateway 地址
  E2E_API_KEY     — Bearer Token
  E2E_SERVICE_ID  — x-tdai-service-id

运行：
  cd sdk/python
  E2E_ENDPOINT=... E2E_API_KEY=... E2E_SERVICE_ID=... python tests/test_e2e.py
"""

import os
import sys
import time

# Load .env from project root
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".env"))
except ImportError:
    pass  # dotenv not installed, rely on env vars

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tencentdb_agent_memory import MemoryClient

ENDPOINT = os.environ.get("E2E_ENDPOINT", "http://127.0.0.1:8420")
API_KEY = os.environ.get("E2E_API_KEY", "test-key")
SERVICE_ID = os.environ.get("E2E_SERVICE_ID", "test-service")
ENABLE_DELETE = os.environ.get("E2E_ENABLE_DELETE", "0") == "1"

TS = int(time.time() * 1000)
SESSION_ID = f"sdk-e2e-py-{TS}"

passed = 0
failed = 0
failures: list[str] = []


def assert_ok(condition: bool, msg: str):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ✅ {msg}")
    else:
        failed += 1
        failures.append(msg)
        print(f"  ❌ {msg}")


def section(name: str):
    print(f"\n━━━ {name} ━━━")


def main():
    print(f"\n🧪 TencentDB Agent Memory Python SDK E2E")
    print(f"   Endpoint:   {ENDPOINT}")
    print(f"   ServiceId:  {SERVICE_ID}")
    print(f"   Session:    {SESSION_ID}")

    client = MemoryClient(
        endpoint=ENDPOINT,
        api_key=API_KEY,
        service_id=SERVICE_ID,
        timeout=30,
    )

    # ════════════════════════════════════════════
    # L0 Conversation
    # ════════════════════════════════════════════
    section("L0 Conversation")

    # add
    add_result = client.add_conversation(SESSION_ID, [
        {"role": "user", "content": "Python SDK E2E 测试消息 1"},
        {"role": "assistant", "content": "收到了，这是回复"},
        {"role": "user", "content": "Python SDK E2E 测试消息 2"},
    ])
    assert_ok(add_result["total_count"] == 3, f"conversation/add: total_count={add_result['total_count']}")
    assert_ok(len(add_result["accepted_ids"]) == 3, f"conversation/add: accepted_ids={len(add_result['accepted_ids'])}")

    # query
    query_result = client.query_conversation(session_id=SESSION_ID, limit=10)
    assert_ok(query_result["total"] >= 3, f"conversation/query: total={query_result['total']}")
    assert_ok(len(query_result["messages"]) >= 3, f"conversation/query: messages={len(query_result['messages'])}")

    # search
    search_result = client.search_conversation("Python SDK E2E", limit=5)
    assert_ok(len(search_result["messages"]) > 0, f"conversation/search: hits={len(search_result['messages'])}")

    # delete — only when E2E_ENABLE_DELETE=1
    if ENABLE_DELETE:
        del_result = client.delete_conversation(session_id=SESSION_ID)
        assert_ok(del_result["deleted_count"] >= 3, f"conversation/delete: deleted_count={del_result['deleted_count']}")

        # verify delete
        after_del = client.query_conversation(session_id=SESSION_ID)
        assert_ok(after_del["total"] == 0, f"conversation/query after delete: total={after_del['total']}")
    else:
        print("  ℹ️  跳过 conversation/delete (E2E_ENABLE_DELETE!=1)")

    # ════════════════════════════════════════════
    # L1 Atomic
    # ════════════════════════════════════════════
    section("L1 Atomic")

    # query
    atomic_query = client.query_atomic(limit=5)
    assert_ok(atomic_query["total"] >= 0, f"atomic/query: total={atomic_query['total']}")

    # search
    atomic_search = client.search_atomic("测试", limit=5)
    assert_ok(isinstance(atomic_search["items"], list), f"atomic/search: items is list (len={len(atomic_search['items'])})")

    # update + revert (if items exist)
    if atomic_query["items"]:
        target = atomic_query["items"][0]
        original_content = target["content"]
        updated_content = f"{original_content} [SDK E2E {TS}]"

        update_result = client.update_atomic(target["id"], updated_content)
        assert_ok(bool(update_result.get("updated_at")), f"atomic/update: updated_at={update_result.get('updated_at')}")

        # read back to verify timestamp marker
        after_update = client.query_atomic(limit=50)
        found = next((i for i in after_update["items"] if i["id"] == target["id"]), None)
        assert_ok(found is not None and f"[SDK E2E {TS}]" in found["content"], f"atomic/update verify: marker [SDK E2E {TS}] found")

        # revert
        client.update_atomic(target["id"], original_content)
        print("  ℹ️  已还原 atomic content")

        # delete (if E2E_ENABLE_DELETE and >= 2 items)
        if ENABLE_DELETE and len(atomic_query["items"]) >= 2:
            last_item = atomic_query["items"][-1]
            del_result = client.delete_atomic([last_item["id"]])
            assert_ok(del_result.get("deleted_count", 0) >= 1, f"atomic/delete: deleted_count={del_result.get('deleted_count')}")

            # verify gone
            import time; time.sleep(2)
            after_atomic_del = client.query_atomic(limit=50)
            still_exists = any(i["id"] == last_item["id"] for i in after_atomic_del["items"])
            assert_ok(not still_exists, f"atomic/delete verify: id={last_item['id']} not found after delete")
        elif not ENABLE_DELETE:
            print("  ℹ️  跳过 atomic/delete (E2E_ENABLE_DELETE!=1)")
        else:
            print("  ℹ️  L1 记忆不足 2 条，跳过 atomic/delete")
    else:
        print("  ℹ️  暂无 L1 记忆，跳过 update")

    # ════════════════════════════════════════════
    # L2 Scenario
    # ════════════════════════════════════════════
    section("L2 Scenario")

    # ls
    ls_result = client.list_scenarios()
    assert_ok(ls_result["total"] >= 0, f"scenario/ls: total={ls_result['total']}")
    assert_ok(isinstance(ls_result["entries"], list), "scenario/ls: entries is list")

    if ls_result["entries"]:
        first_file = next((e for e in ls_result["entries"] if not e["path"].endswith("/")), None)
        if first_file:
            # read
            read_result = client.read_scenario(first_file["path"])
            assert_ok(bool(read_result.get("content")), f"scenario/read \"{first_file['path']}\": content.length={len(read_result.get('content', ''))}")
            assert_ok(bool(read_result.get("updated_at")), "scenario/read: has updated_at")

            # write
            import re
            content_no_meta = re.sub(r"^-----META-START-----[\s\S]*?-----META-END-----\n*", "", read_result["content"])
            marker = f"\n<!-- Python SDK E2E {TS} -->"
            write_result = client.write_scenario(first_file["path"], content_no_meta + marker, summary="Python SDK E2E")
            assert_ok(bool(write_result.get("updated_at")), f"scenario/write: updated_at={write_result.get('updated_at')}")

            # verify
            verify_read = client.read_scenario(first_file["path"])
            assert_ok("Python SDK E2E" in verify_read["content"], "scenario/read verify: marker found")
    else:
        print("  ℹ️  暂无 scenario 文件，跳过 read/write")

    # ════════════════════════════════════════════
    # L3 Core (Persona)
    # ════════════════════════════════════════════
    section("L3 Core")

    # read
    core_read = client.read_core()
    if core_read.get("content"):
        assert_ok(len(core_read["content"]) > 0, f"core/read: content.length={len(core_read['content'])}")

        # write
        core_marker = f"\n\n<!-- Python SDK E2E marker {TS} -->"
        core_write = client.write_core(core_read["content"] + core_marker)
        assert_ok(bool(core_write.get("updated_at")), f"core/write: updated_at={core_write.get('updated_at')}")

        # verify
        core_verify = client.read_core()
        assert_ok("Python SDK E2E marker" in core_verify["content"], "core/read verify: marker found")
    else:
        print("  ℹ️  暂无 persona，跳过 core/write")

    # ════════════════════════════════════════════
    # Summary
    # ════════════════════════════════════════════
    total = passed + failed
    print("")
    if failed == 0:
        print("\033[42m\033[30m                                                  \033[0m")
        print(f"\033[42m\033[30m   ✅  ALL {total} TESTS PASSED                        \033[0m")
        print("\033[42m\033[30m                                                  \033[0m")
    else:
        print("\033[41m\033[37m                                                  \033[0m")
        print(f"\033[41m\033[37m   ❌  {failed} / {total} TESTS FAILED                      \033[0m")
        print("\033[41m\033[37m                                                  \033[0m")
        print("")
        print("  \033[31m┌─── Failures ───────────────────────────────┐\033[0m")
        for f in failures:
            print(f"  \033[31m│\033[0m  • {f}")
        print("  \033[31m└────────────────────────────────────────────┘\033[0m")
    print("")

    client.close()
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()
