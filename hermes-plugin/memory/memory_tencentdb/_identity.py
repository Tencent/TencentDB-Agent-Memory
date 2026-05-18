"""Pure-Python identity resolution helpers for the memory-tencentdb provider.

Kept in a standalone module so the helpers can be unit-tested without
importing ``__init__.py`` (which depends on ``agent.memory_provider`` — only
present inside a hermes-agent checkout).
"""

from __future__ import annotations

from typing import Any, Dict


def resolve_user_id(kwargs: Dict[str, Any]) -> str:
    """Resolve the per-session ``user_id`` from Hermes ``initialize`` kwargs.

    Hermes passes two relevant identity kwargs to memory providers:

      * ``user_id`` — set by gateway-style integrations (Telegram, Discord, …)
        where each end-user has their own scope.
      * ``agent_identity`` — set by the CLI when a profile is in use, e.g.
        ``hermes --profile work`` → ``agent_identity="work"``. See Hermes
        ``run_agent.py`` (``_init_kwargs["agent_identity"] = _profile``).

    Falling back to a single hardcoded ``"default"`` ignored ``agent_identity``
    entirely, causing every CLI profile to share the same memory pool — see
    https://github.com/Tencent/TencentDB-Agent-Memory/issues/15.

    Priority (first non-empty wins, otherwise ``"default"``):

      1. ``user_id`` — preserves the multi-user isolation already used by
         gateway integrations.
      2. ``agent_identity`` — new: gives ``--profile`` users separate scopes.
      3. ``"default"`` — historical fallback for the bare CLI invocation.

    Empty strings are treated as "not set" so a deliberate ``user_id=""`` from
    a misconfigured gateway falls through to ``agent_identity`` rather than
    silently overriding it.
    """
    return (
        kwargs.get("user_id")
        or kwargs.get("agent_identity")
        or "default"
    )
