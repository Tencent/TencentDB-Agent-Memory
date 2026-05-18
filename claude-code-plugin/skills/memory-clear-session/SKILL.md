---
name: memory-clear-session
description: Manually clear the current session's accumulated memory buffer for this working directory. DESTRUCTIVE — call only when the user explicitly asks to forget the current context.
disable-model-invocation: true
---

The user has explicitly requested to clear this session's memory buffer.

!`node "${CLAUDE_PLUGIN_ROOT}/dist/lib/hook.mjs" clear-session`

Confirm to the user that the session buffer was cleared. Long-term memories (L1/L2/L3) are untouched.
