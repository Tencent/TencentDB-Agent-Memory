"""Unit tests for memory file reader module (cos.py)."""

import hashlib
import hmac
import time
from typing import Any, Dict, Optional
from unittest.mock import MagicMock, patch

import pytest

from tencentdb_agent_memory.cos import (
    MemoryFileReader,
    StsCredential,
    StsCredentialManager,
    _cos_v5_sign,
    _parse_cos_url,
)
from tencentdb_agent_memory.errors import TDAMError


# ---------------------------------------------------------------------------
# _parse_cos_url tests
# ---------------------------------------------------------------------------

class TestParseCosUrl:
    def test_standard(self):
        bucket, region = _parse_cos_url("https://my-test-bucket-1250000000.cos.ap-guangzhou.myqcloud.com")
        assert bucket == "my-test-bucket-1250000000"
        assert region == "ap-guangzhou"

    def test_invalid_url(self):
        with pytest.raises(TDAMError):
            _parse_cos_url("https://invalid.example.com")


# ---------------------------------------------------------------------------
# StsCredential tests
# ---------------------------------------------------------------------------

class TestStsCredential:
    def test_parse(self):
        cred = StsCredential({
            "CosUrl": "https://my-bucket.cos.ap-guangzhou.myqcloud.com",
            "TmpSecretId": "AK_test",
            "TmpSecretKey": "SK_test",
            "TmpToken": "tok",
            "ExpirationTime": "2099-01-01T00:00:00Z",
            "PathPrefix": "memory_v2/cos_data/mem-xxx",
        })
        assert cred.tmp_secret_id == "AK_test"
        assert cred.bucket == "my-bucket"
        assert cred.region == "ap-guangzhou"
        assert cred.prefix == "memory_v2/cos_data/mem-xxx/"
        assert cred.cos_host == "my-bucket.cos.ap-guangzhou.myqcloud.com"
        assert cred.is_valid()

    def test_prefix_trailing_slash(self):
        cred = StsCredential({
            "CosUrl": "https://b.cos.r.myqcloud.com",
            "TmpSecretId": "AK",
            "TmpSecretKey": "SK",
            "TmpToken": "",
            "ExpirationTime": "2099-01-01T00:00:00Z",
            "PathPrefix": "pfx/",
        })
        assert cred.prefix == "pfx/"

    def test_expired(self):
        cred = StsCredential({
            "CosUrl": "https://b.cos.r.myqcloud.com",
            "TmpSecretId": "AK",
            "TmpSecretKey": "SK",
            "TmpToken": "",
            "ExpirationTime": "2020-01-01T00:00:00Z",
            "PathPrefix": "",
        })
        assert not cred.is_valid()


# ---------------------------------------------------------------------------
# StsCredentialManager tests
# ---------------------------------------------------------------------------

class TestStsCredentialManager:
    def _platform_response(self, expires_delta: float = 1800) -> dict:
        from datetime import datetime, timezone, timedelta
        exp = datetime.now(timezone.utc) + timedelta(seconds=expires_delta)
        return {
            "CosUrl": "https://test-bucket.cos.ap-guangzhou.myqcloud.com",
            "TmpSecretId": "AK_test",
            "TmpSecretKey": "SK_test",
            "TmpToken": "tok_test",
            "ExpirationTime": exp.isoformat(),
            "PathPrefix": "test/",
        }

    @patch("tencentdb_agent_memory.cos.httpx.Client")
    def test_fetch_on_first_call(self, MockClient):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = self._platform_response()
        MockClient.return_value.post.return_value = mock_resp

        mgr = StsCredentialManager(
            endpoint="https://api.example.com",
            api_key="sk-test",
            service_id="mem-001",
        )
        cred = mgr.get_credential()
        assert cred.tmp_secret_id == "AK_test"
        MockClient.return_value.post.assert_called_once()
        call_args = MockClient.return_value.post.call_args
        assert "/v2/cos/secret" in call_args[0][0]

    @patch("tencentdb_agent_memory.cos.httpx.Client")
    def test_cache_hit(self, MockClient):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = self._platform_response()
        MockClient.return_value.post.return_value = mock_resp

        mgr = StsCredentialManager(
            endpoint="https://api.example.com",
            api_key="sk-test",
            service_id="mem-001",
        )
        mgr.get_credential()
        mgr.get_credential()
        assert MockClient.return_value.post.call_count == 1

    @patch("tencentdb_agent_memory.cos.httpx.Client")
    def test_invalidate_forces_refetch(self, MockClient):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = self._platform_response()
        MockClient.return_value.post.return_value = mock_resp

        mgr = StsCredentialManager(
            endpoint="https://api.example.com",
            api_key="sk-test",
            service_id="mem-001",
        )
        mgr.get_credential()
        mgr.invalidate()
        mgr.get_credential()
        assert MockClient.return_value.post.call_count == 2


# ---------------------------------------------------------------------------
# COS V5 signature tests
# ---------------------------------------------------------------------------

class TestCosV5Sign:
    def test_signature_format(self):
        auth = _cos_v5_sign(
            secret_id="AKID_test",
            secret_key="SK_test",
            method="GET",
            path="/test/file.md",
            host="bucket.cos.ap-guangzhou.myqcloud.com",
            start_time=1000000,
            end_time=1000600,
        )
        assert "q-sign-algorithm=sha1" in auth
        assert "q-ak=AKID_test" in auth
        assert "q-sign-time=1000000;1000600" in auth
        assert "q-signature=" in auth

    def test_deterministic(self):
        kwargs = dict(
            secret_id="AK", secret_key="SK",
            method="GET", path="/a.md",
            host="b.cos.r.myqcloud.com",
            start_time=100, end_time=200,
        )
        assert _cos_v5_sign(**kwargs) == _cos_v5_sign(**kwargs)


# ---------------------------------------------------------------------------
# MemoryFileReader tests (mock HTTP)
# ---------------------------------------------------------------------------

class TestMemoryFileReader:
    def _make_reader(self, http_response: Any = None) -> tuple:
        from datetime import datetime, timezone, timedelta
        exp = datetime.now(timezone.utc) + timedelta(seconds=1800)
        platform_resp = {
            "CosUrl": "https://bkt.cos.ap-gz.myqcloud.com",
            "TmpSecretId": "AK",
            "TmpSecretKey": "SK",
            "TmpToken": "tok",
            "ExpirationTime": exp.isoformat(),
            "PathPrefix": "pfx/",
        }
        mock_sts_resp = MagicMock()
        mock_sts_resp.status_code = 200
        mock_sts_resp.raise_for_status = MagicMock()
        mock_sts_resp.json.return_value = platform_resp

        with patch("tencentdb_agent_memory.cos.httpx.Client") as MockClient:
            MockClient.return_value.post.return_value = mock_sts_resp
            mgr = StsCredentialManager(
                endpoint="https://api.example.com",
                api_key="sk-test",
                service_id="mem-001",
            )
            # Pre-populate credential
            mgr.get_credential()

        mock_cos_client = MagicMock()
        if http_response is not None:
            mock_cos_client.get.return_value = http_response
        reader = MemoryFileReader(mgr, client=mock_cos_client)
        return reader, mock_cos_client

    def test_read_success(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = "# Hello World"
        reader, client = self._make_reader(mock_resp)
        result = reader.read("scene_blocks/test.md")
        assert result == "# Hello World"
        client.get.assert_called_once()
        call_url = client.get.call_args[0][0]
        assert "pfx/scene_blocks/test.md" in call_url

    def test_read_404(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 404
        reader, _ = self._make_reader(mock_resp)
        with pytest.raises(TDAMError) as exc_info:
            reader.read("nonexistent.md")
        assert exc_info.value.code == 404

    def test_security_token_header(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = "ok"
        reader, client = self._make_reader(mock_resp)
        reader.read("test.md")
        call_headers = client.get.call_args[1]["headers"]
        assert "x-cos-security-token" in call_headers
        assert call_headers["x-cos-security-token"] == "tok"
