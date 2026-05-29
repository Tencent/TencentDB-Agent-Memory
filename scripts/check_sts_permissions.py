#!/usr/bin/env python3
"""
STS 临时密钥权限排查脚本
从 Shark 获取 COS 凭证，逐项测试各种 COS 操作权限。

用法: python3 check_sts_permissions.py
依赖: pip install cos-python-sdk-v5
"""

import json
import re
import sys
import urllib.request
import traceback

SHARK_URL = "http://tdai.gateway.cd.test.polaris:8000/meta/GetMemoryPlusCosConfig"
INSTANCE_ID = "mem-rkgqhd5z"


def fetch_cos_config():
    """从 Shark 获取 COS 配置"""
    req = urllib.request.Request(
        SHARK_URL,
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=10)
    payload = json.loads(resp.read())
    print("=" * 60)
    print("Shark 原始返回:")
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    print("=" * 60)

    if payload.get("code") != 0:
        print(f"Shark 返回错误: code={payload.get('code')}, message={payload.get('message')}")
        sys.exit(1)

    return payload["data"]


def parse_cos_url(cos_url):
    """解析 COS URL 提取 bucket 和 region"""
    host = cos_url.replace("https://", "").replace("http://", "").rstrip("/")
    m = re.match(r"^(.+?)\.cos(?:-internal)?\.(.+?)\.(?:myqcloud\.com|tencentcos\.cn)$", host)
    if not m:
        raise ValueError(f"无法解析 COS URL: {cos_url}")
    return m.group(1), m.group(2)


def test_permissions(data):
    """逐项测试 COS 操作权限"""
    try:
        from qcloud_cos import CosConfig, CosS3Client
    except ImportError:
        print("\n请先安装 COS SDK: pip install cos-python-sdk-v5")
        sys.exit(1)

    cos_url = data["CosUrl"]
    secret_id = data["TmpSecretId"]
    secret_key = data["TmpSecretKey"]
    token = data["TmpToken"]
    path_prefix = data["PathPrefix"]
    expiration = data.get("ExpirationTime", "未知")

    bucket, region = parse_cos_url(cos_url)

    print(f"\n凭证信息:")
    print(f"  CosUrl:       {cos_url}")
    print(f"  Bucket:       {bucket}")
    print(f"  Region:       {region}")
    print(f"  TmpSecretId:  {secret_id[:10]}...{secret_id[-4:]}")
    print(f"  TmpSecretKey: {secret_key[:6]}...{secret_key[-4:]}")
    print(f"  TmpToken:     {'有' if token else '无'} (长度={len(token) if token else 0})")
    print(f"  PathPrefix:   {path_prefix}")
    print(f"  Expiration:   {expiration}")

    # 实际 prefix（按 memory service 逻辑拼接）
    prefix = f"{path_prefix.rstrip('/')}/{INSTANCE_ID}/"
    print(f"  实际 Key 前缀: {prefix}")

    # 同时测试外网域名（开发机可能无法访问 cos-internal）
    # 如果 CosUrl 是内网域名，先用外网试
    use_public = "cos-internal" in cos_url or "tencentcos.cn" in cos_url
    if use_public:
        print(f"\n  注意: CosUrl 为内网域名，将同时用外网域名测试")

    config = CosConfig(
        Region=region,
        SecretId=secret_id,
        SecretKey=secret_key,
        Token=token,
    )
    client = CosS3Client(config)

    test_key = f"{prefix}__permission_test__.txt"
    results = {}

    # ── Test 1: GetService (列出所有 Bucket) ──
    print(f"\n{'─' * 60}")
    print("Test 1: GetService (列出所有 Bucket)")
    try:
        resp = client.list_buckets()
        buckets = resp.get("Buckets", {}).get("Bucket", [])
        results["GetService"] = f"OK ({len(buckets)} buckets)"
        print(f"  ✅ OK - 可见 {len(buckets)} 个 Bucket")
        for b in buckets[:5]:
            print(f"     - {b.get('Name', '?')} ({b.get('Location', '?')})")
        if len(buckets) > 5:
            print(f"     ... 及其他 {len(buckets) - 5} 个")
    except Exception as e:
        results["GetService"] = f"DENIED ({e})"
        print(f"  ❌ DENIED - {e}")

    # ── Test 2: HeadBucket (检查 Bucket 是否存在/可访问) ──
    print(f"\nTest 2: HeadBucket (Bucket={bucket})")
    try:
        client.head_bucket(Bucket=bucket)
        results["HeadBucket"] = "OK"
        print(f"  ✅ OK - Bucket 存在且可访问")
    except Exception as e:
        results["HeadBucket"] = f"DENIED ({e})"
        print(f"  ❌ DENIED - {e}")

    # ── Test 3: GetBucket / ListObjects (在 prefix 下列出对象) ──
    print(f"\nTest 3: ListObjects (Prefix={prefix})")
    try:
        resp = client.list_objects(Bucket=bucket, Prefix=prefix, MaxKeys=10)
        contents = resp.get("Contents", [])
        results["ListObjects"] = f"OK ({len(contents)} objects)"
        print(f"  ✅ OK - 列出 {len(contents)} 个对象")
        for c in contents[:5]:
            print(f"     - {c['Key']} ({c['Size']} bytes)")
    except Exception as e:
        results["ListObjects"] = f"DENIED ({e})"
        print(f"  ❌ DENIED - {e}")

    # ── Test 3b: ListObjects 在 PathPrefix 下（不带 instanceId）──
    raw_prefix = path_prefix.rstrip("/") + "/"
    print(f"\nTest 3b: ListObjects (Prefix={raw_prefix}, 不带 instanceId)")
    try:
        resp = client.list_objects(Bucket=bucket, Prefix=raw_prefix, MaxKeys=10)
        contents = resp.get("Contents", [])
        results["ListObjects(raw)"] = f"OK ({len(contents)} objects)"
        print(f"  ✅ OK - 列出 {len(contents)} 个对象")
        for c in contents[:5]:
            print(f"     - {c['Key']} ({c['Size']} bytes)")
    except Exception as e:
        results["ListObjects(raw)"] = f"DENIED ({e})"
        print(f"  ❌ DENIED - {e}")

    # ── Test 3c: ListObjects 在 bucket 根目录 ──
    print(f"\nTest 3c: ListObjects (Prefix='', Bucket 根目录)")
    try:
        resp = client.list_objects(Bucket=bucket, Prefix="", MaxKeys=10)
        contents = resp.get("Contents", [])
        results["ListObjects(root)"] = f"OK ({len(contents)} objects)"
        print(f"  ✅ OK - 列出 {len(contents)} 个对象")
        for c in contents[:5]:
            print(f"     - {c['Key']} ({c['Size']} bytes)")
    except Exception as e:
        results["ListObjects(root)"] = f"DENIED ({e})"
        print(f"  ❌ DENIED - {e}")

    # ── Test 4: PutObject (写入测试文件) ──
    print(f"\nTest 4: PutObject (Key={test_key})")
    try:
        resp = client.put_object(
            Bucket=bucket,
            Body=b"permission test",
            Key=test_key,
            ContentType="text/plain",
        )
        results["PutObject"] = f"OK (ETag={resp.get('ETag', '?')})"
        print(f"  ✅ OK - ETag={resp.get('ETag', '?')}")
    except Exception as e:
        results["PutObject"] = f"DENIED ({e})"
        print(f"  ❌ DENIED - {e}")

    # ── Test 5: GetObject (读取刚写入的文件) ──
    print(f"\nTest 5: GetObject (Key={test_key})")
    try:
        resp = client.get_object(Bucket=bucket, Key=test_key)
        body = resp["Body"].get_raw_stream().read()
        results["GetObject"] = f"OK ({len(body)} bytes)"
        print(f"  ✅ OK - 读到 {len(body)} 字节: {body[:50]}")
    except Exception as e:
        results["GetObject"] = f"DENIED ({e})"
        print(f"  ❌ DENIED - {e}")

    # ── Test 6: HeadObject (获取文件元数据) ──
    print(f"\nTest 6: HeadObject (Key={test_key})")
    try:
        resp = client.head_object(Bucket=bucket, Key=test_key)
        results["HeadObject"] = f"OK (size={resp.get('Content-Length', '?')})"
        print(f"  ✅ OK - Content-Length={resp.get('Content-Length', '?')}")
    except Exception as e:
        results["HeadObject"] = f"DENIED ({e})"
        print(f"  ❌ DENIED - {e}")

    # ── Test 7: DeleteObject (删除测试文件) ──
    print(f"\nTest 7: DeleteObject (Key={test_key})")
    try:
        client.delete_object(Bucket=bucket, Key=test_key)
        results["DeleteObject"] = "OK"
        print(f"  ✅ OK - 删除成功")
    except Exception as e:
        results["DeleteObject"] = f"DENIED ({e})"
        print(f"  ❌ DENIED - {e}")

    # ── 汇总 ──
    print(f"\n{'=' * 60}")
    print("权限汇总:")
    print(f"{'=' * 60}")
    for op, status in results.items():
        icon = "✅" if status.startswith("OK") else "❌"
        print(f"  {icon} {op:25s} → {status}")
    print(f"{'=' * 60}")

    ok_count = sum(1 for s in results.values() if s.startswith("OK"))
    total = len(results)
    print(f"\n结论: {ok_count}/{total} 项操作有权限")

    if ok_count == 0:
        print("⚠️  STS 临时密钥无任何 COS 操作权限！需要 Shark 团队修复 STS Policy。")
        print("   所需权限: cos:GetObject, cos:PutObject, cos:DeleteObject, cos:GetBucket, cos:HeadObject")
    elif ok_count < total:
        denied = [op for op, s in results.items() if not s.startswith("OK")]
        print(f"⚠️  部分操作无权限: {', '.join(denied)}")
    else:
        print("✅ STS 临时密钥拥有完整的 COS 操作权限，write_scenario 应该可以正常工作。")


if __name__ == "__main__":
    print("STS 临时密钥权限排查")
    print(f"Shark 地址: {SHARK_URL}")
    print(f"实例 ID: {INSTANCE_ID}")

    data = fetch_cos_config()
    test_permissions(data)
