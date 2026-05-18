"""Tests for ``resolve_user_id`` — the kwargs → user_id mapping used by
``MemoryTencentdbProvider.initialize``.

Verifies the fix for
https://github.com/Tencent/TencentDB-Agent-Memory/issues/15: Hermes
``--profile`` users were silently sharing one memory pool because the
provider hardcoded ``kwargs.get("user_id", "default")`` and ignored
``agent_identity``. The new resolver falls back to ``agent_identity`` when
no gateway ``user_id`` is present.

This is a pure-function test — no Gateway / Supervisor / network involved.

We load ``_identity.py`` directly via ``importlib`` rather than ``import
memory.memory_tencentdb._identity`` so that triggering the package's
``__init__.py`` (which itself imports ``agent.memory_provider``) is not
required — that module only exists inside a hermes-agent checkout, and we
want this test to run standalone in the plugin repo.
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys


def _load_identity_module():
    here = pathlib.Path(__file__).resolve().parent
    module_path = here.parent / "_identity.py"
    spec = importlib.util.spec_from_file_location(
        "memory_tencentdb_identity_under_test", module_path
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load _identity.py at {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


_identity = _load_identity_module()
resolve_user_id = _identity.resolve_user_id


def test_empty_kwargs_returns_default():
    """Bare CLI invocation (no profile, no gateway): historical fallback."""
    assert resolve_user_id({}) == "default"


def test_gateway_user_id_wins():
    """Gateway integrations (Telegram, Discord, …) pass ``user_id`` — preserved."""
    assert resolve_user_id({"user_id": "alice"}) == "alice"


def test_agent_identity_used_when_no_user_id():
    """``hermes --profile work`` → ``agent_identity="work"`` becomes the scope."""
    assert resolve_user_id({"agent_identity": "work"}) == "work"


def test_user_id_takes_priority_over_agent_identity():
    """When both are present (gateway request from a profile session),
    multi-user isolation must take priority over per-profile isolation."""
    assert (
        resolve_user_id({"user_id": "alice", "agent_identity": "work"})
        == "alice"
    )


def test_empty_strings_fall_through():
    """Empty strings are treated as 'not set' — a misconfigured gateway
    sending ``user_id=""`` falls through to ``agent_identity`` rather than
    silently masking the profile scope."""
    assert resolve_user_id({"user_id": "", "agent_identity": "work"}) == "work"
    assert resolve_user_id({"user_id": "", "agent_identity": ""}) == "default"


def test_other_kwargs_ignored():
    """Unrelated kwargs (``agent_workspace`` etc.) don't interfere with the
    resolution. Hermes ``run_agent.py`` also passes ``agent_workspace`` and
    other identity-adjacent kwargs that this resolver must ignore."""
    assert (
        resolve_user_id({"agent_workspace": "hermes", "agent_identity": "work"})
        == "work"
    )
    assert resolve_user_id({"agent_workspace": "hermes"}) == "default"
