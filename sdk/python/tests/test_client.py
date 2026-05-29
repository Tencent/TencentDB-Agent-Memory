"""Unit tests for tencentdb_agent_memory.MemoryClient (mock transport, no network)."""

from __future__ import annotations

import pytest

from tencentdb_agent_memory import MemoryClient, TDAMError
from tencentdb_agent_memory._http import Stub


# ---------------------------------------------------------------------------
# Mock stub
# ---------------------------------------------------------------------------

class MockStub(Stub):
    """Records calls and returns canned responses."""

    def __init__(self, responses: dict | None = None) -> None:
        self.calls: list[tuple[str, dict]] = []
        self._responses = responses or {}
        self.closed = False

    def post(self, path: str, body: dict, timeout=None) -> dict:
        self.calls.append((path, body))
        if path in self._responses:
            return self._responses[path]
        return {}

    def close(self) -> None:
        self.closed = True


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def stub():
    return MockStub(responses={
        "/v2/conversation/add": {"accepted_ids": ["msg-1"], "total_count": 1},
        "/v2/conversation/query": {"messages": [], "total": 0},
        "/v2/conversation/search": {"messages": []},
        "/v2/conversation/delete": {"deleted_count": 2},
        "/v2/atomic/update": {"id": "note-1", "updated_at": "2026-01-01T00:00:00Z"},
        "/v2/atomic/query": {"items": [], "total": 0},
        "/v2/atomic/search": {"items": []},
        "/v2/atomic/delete": {"deleted_count": 1},
        "/v2/scenario/ls": {"entries": [], "total": 0},
        "/v2/scenario/read": {"path": "a.md", "content": "# hi", "created_at": "t", "updated_at": "t"},
        "/v2/scenario/write": {"path": "a.md", "updated_at": "t"},
        "/v2/scenario/rm": {},
        "/v2/core/read": {"content": "# persona", "created_at": "t", "updated_at": "t"},
        "/v2/core/write": {"updated_at": "t"},
    })


@pytest.fixture()
def client(stub: MockStub):
    return MemoryClient(stub=stub)


# ---------------------------------------------------------------------------
# Tests — L0 Conversation
# ---------------------------------------------------------------------------

class TestConversation:
    def test_add(self, client: MemoryClient, stub: MockStub):
        result = client.add_conversation("sess-1", [{"role": "user", "content": "hi"}])
        assert result["accepted_ids"] == ["msg-1"]
        path, body = stub.calls[-1]
        assert path == "/v2/conversation/add"
        assert body["session_id"] == "sess-1"
        assert len(body["messages"]) == 1

    def test_query(self, client: MemoryClient, stub: MockStub):
        client.query_conversation(session_id="s", limit=10, offset=0)
        _, body = stub.calls[-1]
        assert body == {"session_id": "s", "limit": 10, "offset": 0}

    def test_query_strips_none(self, client: MemoryClient, stub: MockStub):
        client.query_conversation()
        _, body = stub.calls[-1]
        assert body == {}

    def test_search(self, client: MemoryClient, stub: MockStub):
        client.search_conversation("rust", limit=5)
        _, body = stub.calls[-1]
        assert body == {"query": "rust", "limit": 5}

    def test_delete_by_ids(self, client: MemoryClient, stub: MockStub):
        result = client.delete_conversation(message_ids=["m1", "m2"])
        assert result["deleted_count"] == 2
        _, body = stub.calls[-1]
        assert body == {"message_ids": ["m1", "m2"]}

    def test_delete_by_session(self, client: MemoryClient, stub: MockStub):
        client.delete_conversation(session_id="s1")
        _, body = stub.calls[-1]
        assert body == {"session_id": "s1"}


# ---------------------------------------------------------------------------
# Tests — L1 Atomic
# ---------------------------------------------------------------------------

class TestAtomic:
    def test_update(self, client: MemoryClient, stub: MockStub):
        result = client.update_atomic("note-1", "updated content", background="ctx")
        assert result["id"] == "note-1"
        _, body = stub.calls[-1]
        assert body == {"id": "note-1", "content": "updated content", "background": "ctx"}

    def test_update_without_background(self, client: MemoryClient, stub: MockStub):
        client.update_atomic("note-1", "new text")
        _, body = stub.calls[-1]
        assert body == {"id": "note-1", "content": "new text"}
        assert "background" not in body

    def test_query(self, client: MemoryClient, stub: MockStub):
        client.query_atomic(type="persona", limit=5, offset=0)
        _, body = stub.calls[-1]
        assert body == {"type": "persona", "limit": 5, "offset": 0}

    def test_search(self, client: MemoryClient, stub: MockStub):
        client.search_atomic("programming", type="episodic")
        _, body = stub.calls[-1]
        assert body == {"query": "programming", "type": "episodic"}

    def test_delete(self, client: MemoryClient, stub: MockStub):
        result = client.delete_atomic(["n1"])
        assert result["deleted_count"] == 1
        _, body = stub.calls[-1]
        assert body == {"ids": ["n1"]}


# ---------------------------------------------------------------------------
# Tests — L2 Scenario
# ---------------------------------------------------------------------------

class TestScenario:
    def test_list(self, client: MemoryClient, stub: MockStub):
        client.list_scenarios(path_prefix="工作/")
        _, body = stub.calls[-1]
        assert body == {"path_prefix": "工作/"}

    def test_read(self, client: MemoryClient, stub: MockStub):
        result = client.read_scenario("a.md")
        assert result["content"] == "# hi"

    def test_write(self, client: MemoryClient, stub: MockStub):
        client.write_scenario("b.md", "# content", summary="test summary")
        _, body = stub.calls[-1]
        assert body == {"path": "b.md", "content": "# content", "summary": "test summary"}

    def test_write_without_summary(self, client: MemoryClient, stub: MockStub):
        client.write_scenario("b.md", "# content")
        _, body = stub.calls[-1]
        assert body == {"path": "b.md", "content": "# content"}
        assert "summary" not in body

    def test_rm(self, client: MemoryClient, stub: MockStub):
        client.rm_scenario("b.md")
        _, body = stub.calls[-1]
        assert body == {"path": "b.md"}


# ---------------------------------------------------------------------------
# Tests — L3 Core
# ---------------------------------------------------------------------------

class TestCore:
    def test_read(self, client: MemoryClient, stub: MockStub):
        result = client.read_core()
        assert result["content"] == "# persona"

    def test_write(self, client: MemoryClient, stub: MockStub):
        client.write_core("# new persona")
        _, body = stub.calls[-1]
        assert body == {"content": "# new persona"}


# ---------------------------------------------------------------------------
# Tests — Error handling
# ---------------------------------------------------------------------------

class TestErrorHandling:
    def test_init_requires_service_id(self):
        with pytest.raises(ValueError, match="service_id"):
            MemoryClient(endpoint="http://x", api_key="k")

    def test_stub_injection_skips_service_id_check(self):
        stub = MockStub()
        c = MemoryClient(stub=stub)
        # should not raise — stub injected, no need for service_id
        c.close()
        assert stub.closed


# ---------------------------------------------------------------------------
# Tests — Context manager
# ---------------------------------------------------------------------------

class TestContextManager:
    def test_sync_context_manager(self, stub: MockStub):
        with MemoryClient(stub=stub) as c:
            c.read_core()
        assert stub.closed
