---
name: tdai-memory
description: TencentDB Agent Memory provides long-term memory (user preferences, past decisions, style) and short-term project context. Use this skill to understand how to leverage memory in this conversation.
---

# Using TencentDB Agent Memory

This plugin gives Claude long-term + symbolic short-term memory.

## What happens automatically

- Every prompt: relevant past memories are pre-loaded into context (via `UserPromptSubmit` hook → `/recall`)
- Every turn: the user/assistant exchange is captured to L0 (via `Stop` hook → `/capture`); structured L1/L2/L3 extraction runs in the background

## Manual control (slash skills)

- `/memory-search <query>` — search past memories for a specific topic
- `/memory-status` — check daemon health
- `/memory-clear-session` — clear the current session's buffer (manual invocation only)

## Hints for Claude

When the user asks "do you remember…" or references prior work, the recalled context (in the `<system-reminder>` block this turn) is your source. If the context is missing, suggest the user run `/memory-search <query>`.

## Where data lives

Memory is stored under `${CLAUDE_PLUGIN_DATA}/memory-tdai/` — a SQLite + sqlite-vec database plus markdown snapshots. Data is partitioned by working-directory hash by default; export `TDAI_SESSION_KEY=<custom>` to override.

See the project README for full architecture details.
