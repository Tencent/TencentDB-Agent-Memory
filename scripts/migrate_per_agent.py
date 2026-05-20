#!/usr/bin/env python3
"""
TDAI 数据迁移脚本 - 按 agentId 拆分
将 conversations/ 和 records/ 从统一目录拆分到 agents/{agentId}/ 下
scene_blocks 和 persona.md 不拆分（混合内容无法拆，由插件重新生成）

用法: python3 migrate_per_agent.py [--dry-run]
"""

import os
import sys
import json
import shutil
from pathlib import Path

BASE_DIR = Path(os.path.expanduser("~/.openclaw/memory-tdai"))
AGENTS_DIR = BASE_DIR / "agents"
CONVERSATIONS_DIR = BASE_DIR / "conversations"
RECORDS_DIR = BASE_DIR / "records"

KNOWN_AGENTS = ["duoduo", "sugarbaby", "miumiu", "jelly", "der", "zhumi"]

dry_run = "--dry-run" in sys.argv


def ensure_agent_dirs():
    """为每个已知 agent 创建子目录结构"""
    for agent in KNOWN_AGENTS:
        for sub in ["conversations", "records", "scene_blocks", ".metadata"]:
            d = AGENTS_DIR / agent / sub
            if not dry_run:
                d.mkdir(parents=True, exist_ok=True)
            else:
                print(f"  [dry-run] mkdir {d}")


def extract_agent_from_session_key(session_key: str) -> str:
    """从 sessionKey 提取 agentId
    格式: agent:duoduo:feishu:direct:ou_xxx 或 agent:duoduo:feishu:direct:ou_xxx:active-memory:xxx
    """
    if not session_key or not session_key.startswith("agent:"):
        return None
    parts = session_key.split(":")
    if len(parts) >= 2:
        return parts[1]
    return None


def extract_agent_from_source_id(source_id: str) -> str:
    """从 record 的 source_message_ids 提取 agentId
    格式: l0_agent:duoduo:feishu:...
    """
    if not source_id:
        return None
    parts = source_id.split(":")
    if len(parts) >= 2 and parts[0] == "l0_agent":
        return parts[1]
    return None


def migrate_conversations():
    """拆分 conversations/ 按 agentId"""
    print("\n=== 迁移 conversations ===")
    if not CONVERSATIONS_DIR.exists():
        print("  conversations 目录不存在，跳过")
        return

    stats = {}
    unknown_count = 0

    for jsonl_file in sorted(CONVERSATIONS_DIR.glob("*.jsonl")):
        print(f"\n  处理: {jsonl_file.name}")

        # 按agent分组读取
        agent_lines = {a: [] for a in KNOWN_AGENTS}
        agent_lines["unknown"] = []

        with open(jsonl_file, "r", encoding="utf-8") as f:
            for line_no, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    agent_id = extract_agent_from_session_key(rec.get("sessionKey", ""))
                    if agent_id and agent_id in KNOWN_AGENTS:
                        agent_lines[agent_id].append(line)
                        stats[agent_id] = stats.get(agent_id, 0) + 1
                    else:
                        agent_lines["unknown"].append(line)
                        unknown_count += 1
                        if unknown_count <= 5:
                            print(f"    ⚠ unknown agent: sessionKey={rec.get('sessionKey', 'N/A')[:80]}")
                except json.JSONDecodeError:
                    agent_lines["unknown"].append(line)
                    unknown_count += 1

        # 写入各 agent 目录
        for agent_id, lines in agent_lines.items():
            if not lines:
                continue
            target_dir = AGENTS_DIR / agent_id / "conversations"
            target_file = target_dir / jsonl_file.name
            if not dry_run:
                target_dir.mkdir(parents=True, exist_ok=True)
                with open(target_file, "w", encoding="utf-8") as out:
                    out.write("\n".join(lines) + "\n")
            else:
                print(f"    [dry-run] {agent_id}: {len(lines)} lines → {target_file}")

    print(f"\n  conversations 迁移统计:")
    for a in sorted(stats):
        print(f"    {a}: {stats[a]} 条")
    if unknown_count:
        print(f"    unknown: {unknown_count} 条")


def migrate_records():
    """拆分 records/ 按 agentId"""
    print("\n=== 迁移 records ===")
    if not RECORDS_DIR.exists():
        print("  records 目录不存在，跳过")
        return

    stats = {}

    for jsonl_file in sorted(RECORDS_DIR.glob("*.jsonl")):
        print(f"\n  处理: {jsonl_file.name}")

        agent_lines = {a: [] for a in KNOWN_AGENTS}
        agent_lines["unknown"] = []

        with open(jsonl_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    # 从 source_message_ids 提取 agentId
                    agent_id = None
                    src_ids = rec.get("source_message_ids", [])
                    if src_ids:
                        agent_id = extract_agent_from_source_id(src_ids[0])
                    # fallback: 从 sessionKey 提取
                    if not agent_id:
                        agent_id = extract_agent_from_session_key(rec.get("sessionKey", ""))

                    if agent_id and agent_id in KNOWN_AGENTS:
                        agent_lines[agent_id].append(line)
                        stats[agent_id] = stats.get(agent_id, 0) + 1
                    else:
                        agent_lines["unknown"].append(line)
                except json.JSONDecodeError:
                    agent_lines["unknown"].append(line)

        for agent_id, lines in agent_lines.items():
            if not lines:
                continue
            target_dir = AGENTS_DIR / agent_id / "records"
            target_file = target_dir / jsonl_file.name
            if not dry_run:
                target_dir.mkdir(parents=True, exist_ok=True)
                with open(target_file, "w", encoding="utf-8") as out:
                    out.write("\n".join(lines) + "\n")
            else:
                print(f"    [dry-run] {agent_id}: {len(lines)} lines → {target_file}")

    print(f"\n  records 迁移统计:")
    for a in sorted(stats):
        print(f"    {a}: {stats[a]} 条")


def verify_migration():
    """验证迁移结果"""
    print("\n=== 验证迁移结果 ===")
    for agent in KNOWN_AGENTS:
        conv_dir = AGENTS_DIR / agent / "conversations"
        rec_dir = AGENTS_DIR / agent / "records"

        conv_count = 0
        if conv_dir.exists():
            for f in conv_dir.glob("*.jsonl"):
                with open(f) as fh:
                    conv_count += sum(1 for l in fh if l.strip())

        rec_count = 0
        if rec_dir.exists():
            for f in rec_dir.glob("*.jsonl"):
                with open(f) as fh:
                    rec_count += sum(1 for l in fh if l.strip())

        print(f"  {agent}: conversations={conv_count}, records={rec_count}")

    # 检查 unknown
    unknown_dir = AGENTS_DIR / "unknown"
    if unknown_dir.exists():
        for sub in ["conversations", "records"]:
            d = unknown_dir / sub
            if d.exists():
                count = sum(1 for f in d.glob("*.jsonl") for _ in open(f) if _.strip())
                if count > 0:
                    print(f"  ⚠ unknown/{sub}: {count} 条需要人工检查")


def main():
    if dry_run:
        print("🔍 DRY RUN - 不写入文件\n")

    print(f"数据目录: {BASE_DIR}")
    print(f"目标目录: {AGENTS_DIR}")

    # 统计原始数据
    print("\n=== 原始数据统计 ===")
    if CONVERSATIONS_DIR.exists():
        total_conv = sum(1 for f in CONVERSATIONS_DIR.glob("*.jsonl") for _ in open(f) if _.strip())
        print(f"  conversations: {total_conv} 条")
    if RECORDS_DIR.exists():
        total_rec = sum(1 for f in RECORDS_DIR.glob("*.jsonl") for _ in open(f) if _.strip())
        print(f"  records: {total_rec} 条")

    ensure_agent_dirs()
    migrate_conversations()
    migrate_records()

    if not dry_run:
        verify_migration()
        print("\n✅ 迁移完成！")
        print("⚠️ 旧数据保留在原位置，确认无误后可手动删除")
        print("⚠️ persona.md 和 scene_blocks 需要由插件重新生成（按agent独立提炼）")
    else:
        print("\n🔍 DRY RUN 完成 - 加 --dry-run 参数可查看实际写入")


if __name__ == "__main__":
    main()
