#!/usr/bin/env python3
"""Benchmark: current per-instance ZSET vs Scheme D (16-shard global ZSET) timer scanning."""
import redis
import time

r = redis.Redis(host="127.0.0.1", port=6379, decode_responses=True)
r.flushdb()

INSTANCE_COUNT = 100000
SHARD_COUNT = 16
now = int(time.time() * 1000)
expired = now - 1000

SEP = "=" * 60

# ============================================================
# Phase 1: Write 100K per-instance ZSETs (current design)
# ============================================================
print(f"Phase 1: Writing {INSTANCE_COUNT} per-instance ZSETs...")
t0 = time.time()
pipe = r.pipeline()
for i in range(INSTANCE_COUNT):
    inst = f"inst-{i:06d}"
    key = "{" + f"tdai_memory:{inst}" + "}:timers"
    pipe.zadd(key, {"sess_001:L1_idle": expired})
    if i % 5000 == 4999:
        pipe.execute()
        pipe = r.pipeline()
pipe.execute()
write_time_old = time.time() - t0
print(f"  Done: {write_time_old:.2f}s, keys={r.dbsize()}")

# ============================================================
# Phase 2: Simulate current Scanner (iterate all instances)
# ============================================================
print(f"\nPhase 2: Current scanner - iterate {INSTANCE_COUNT} instances...")
start = time.time()
total_expired_old = 0
for i in range(INSTANCE_COUNT):
    inst = f"inst-{i:06d}"
    key = "{" + f"tdai_memory:{inst}" + "}:timers"
    members = r.zrangebyscore(key, "-inf", now)
    if members:
        r.zremrangebyscore(key, "-inf", now)
        total_expired_old += len(members)
old_elapsed = time.time() - start
old_status = "TIMEOUT" if old_elapsed > 2 else "OK"
print(f"  Expired found: {total_expired_old}")
print(f"  Scan time: {old_elapsed:.2f}s [{old_status}] (target: <2s)")
print(f"  Redis ops: ~{INSTANCE_COUNT * 2} (2 per instance)")

# ============================================================
# Phase 3: Write 16-shard ZSETs (Scheme D)
# ============================================================
print(f"\nPhase 3: Writing {INSTANCE_COUNT} timers into {SHARD_COUNT} shards...")
r.flushdb()

def shard_hash(s):
    h = 5381
    for c in s:
        h = ((h << 5) + h + ord(c)) & 0xFFFFFFFF
    return h % SHARD_COUNT

t0 = time.time()
pipe = r.pipeline()
for i in range(INSTANCE_COUNT):
    inst = f"inst-{i:06d}"
    shard = shard_hash(inst)
    key = f"tdai_memory:timers:shard_{shard}"
    member = f"{inst}:sess_001:L1_idle"
    pipe.zadd(key, {member: expired})
    if i % 5000 == 4999:
        pipe.execute()
        pipe = r.pipeline()
pipe.execute()
write_time_new = time.time() - t0
print(f"  Done: {write_time_new:.2f}s, keys={r.dbsize()}")
print(f"  Shard distribution:")
for s in range(SHARD_COUNT):
    cnt = r.zcard(f"tdai_memory:timers:shard_{s}")
    print(f"    shard_{s:02d}: {cnt} members")

# ============================================================
# Phase 4: Scheme D scanner (scan 16 shards with Lua atomic claim)
# ============================================================
print(f"\nPhase 4: Scheme D scanner - scan {SHARD_COUNT} shards (Lua atomic)...")
LUA_CLAIM = """
local members = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 50000)
if #members > 0 then
  redis.call('ZREM', KEYS[1], unpack(members))
  return members
end
return {}
"""
start = time.time()
total_expired_new = 0
for shard in range(SHARD_COUNT):
    key = f"tdai_memory:timers:shard_{shard}"
    members = r.eval(LUA_CLAIM, 1, key, now)
    total_expired_new += len(members)
new_elapsed = time.time() - start
new_status = "TIMEOUT" if new_elapsed > 2 else "OK"
print(f"  Expired found: {total_expired_new}")
print(f"  Scan time: {new_elapsed:.4f}s [{new_status}] (target: <2s)")
print(f"  Redis ops: {SHARD_COUNT} (1 EVAL per shard)")

# ============================================================
# Summary
# ============================================================
print(f"\n{SEP}")
print(f"  BENCHMARK: {INSTANCE_COUNT} instances, 1 timer each")
print(f"{SEP}")
print(f"  Current (per-instance ZSET):  {old_elapsed:.2f}s / scan  [{old_status}]")
print(f"  Scheme D (16 shards):         {new_elapsed:.4f}s / scan  [{new_status}]")
if new_elapsed > 0:
    print(f"  Speedup:                      {old_elapsed/new_elapsed:.0f}x faster")
print(f"  Max shard size:               {max(r.zcard(f'tdai_memory:timers:shard_{s}') for s in range(SHARD_COUNT))} (all consumed)")
print(f"{SEP}")

# Cleanup
r.flushdb()
print("\nRedis flushed. Done.")
