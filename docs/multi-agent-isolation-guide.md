# 📘 Multi-Agent Memory Isolation Guide

## Overview
This guide explains how to use the **Multi-Agent Isolation** feature introduced in PR #96. It solves the data mixing issue in multi-profile setups (e.g., default, xiaoxiao, zhi) by implementing logical isolation in a single SQLite database.

## 💡 Core Design

### Shared vs. Private Memory
The system uses a `shared` area for global context and `private` areas for agent-specific context.

| Memory Type | Isolation Strategy | Description |
| :--- | :--- | :--- |
| **instruction** | 🟢 **Shared** | Rules, preferences, and commands. Visible to all profiles. |
| **persona** | 🟢 **Shared** | User profiles and bio info. Visible to all profiles. |
| **episodic** | 🔴 **Private** | Conversation history and workflow logs. Isolated by agent. |

### Why Single DB?
Unlike multi-database solutions, this approach uses a single `vectors.db` with an `agent_id` column.
*   **Zero Overhead**: Easy backup and migration.
*   **Clean Logic**: Solves "share persona vs isolate context" dilemma efficiently.

---

## 🛠️ Integration Guide

### For Hermes Users ✅
**Zero Configuration Required.**
*   Simply install the updated `memory-tencentdb` plugin.
*   The plugin automatically handles session keys (`agent:{profile}:...`).
*   Isolation works immediately upon restart.

### For OpenClaw Users 🔌
The core storage logic is generic, but your Host Adapter needs to generate the correct session key format.
*   **Requirement**: Ensure `sessionKey` follows the pattern: `agent:{profile_id}:{session_id}`.
*   **Example**:
    *   `agent:default:session-123`
    *   `agent:coding-bot:session-456`

---

## 🔄 Migration from Legacy Versions

If upgrading from a version before this PR, your existing data will lack `agent_id` tags.
*   **Default Behavior**: Untagged data is treated as belonging to the `default` profile.
*   **Recommended Action**: Run the provided migration script to categorize old data.

```bash
# Example command (may vary by release)
python3 scripts/migrate_multi_agent.py
```

---

## ❓ FAQ

**Q: Will I lose my old memories?**
A: No. They will simply be grouped under the `default` profile until you migrate them.

**Q: Does this affect search performance?**
A: Negligible. SQLite indexes on `agent_id` ensure fast retrieval.
