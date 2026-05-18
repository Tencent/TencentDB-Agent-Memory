"""Pytest fixtures / sys.modules stubs for memory_tencentdb plugin tests.

The plugin's ``__init__.py`` imports ``agent.memory_provider.MemoryProvider``,
which only exists inside a hermes-agent checkout. When tests are run
standalone from this plugin repo (e.g. plugin CI, contributor running
``pytest`` from the plugin root), pytest's collection still imports the
package's ``__init__.py`` to resolve ``tests`` as a sub-package — even when
the individual test file itself doesn't touch ``MemoryProvider``.

To let pure-function tests (like ``test_resolve_user_id``) run without a
sibling hermes-agent checkout, we stub the ``agent.memory_provider`` module
with a no-op placeholder *only when the real module is not already
importable*. In a hermes-agent checkout (production / integration tests),
the real ``MemoryProvider`` is on sys.path first and the stub is skipped.
"""

import sys

try:
    import agent.memory_provider  # noqa: F401
except ImportError:
    import types

    _agent_module = types.ModuleType("agent")
    _provider_module = types.ModuleType("agent.memory_provider")

    # Bare base class is enough — pure-function tests don't instantiate the
    # provider; integration tests that do should run against a real
    # hermes-agent checkout where this stub is bypassed.
    class _StubMemoryProvider:
        pass

    _provider_module.MemoryProvider = _StubMemoryProvider
    _agent_module.memory_provider = _provider_module

    sys.modules.setdefault("agent", _agent_module)
    sys.modules.setdefault("agent.memory_provider", _provider_module)
