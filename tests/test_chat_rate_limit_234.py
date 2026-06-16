"""Regression test for #234 — app-layer rate limit on the LLM-backed /chat.

`/chat` had no app-layer cap, so an authenticated user could loop it and run
up Bedrock/LLM spend. A per-identity rule (20/60s) now throttles it via the
existing cloud rate-limit middleware (clean 429 + Retry-After).
"""

from __future__ import annotations

import asyncio
import importlib
import sys
import types
from types import SimpleNamespace

from starlette.requests import Request
from starlette.responses import Response


def _load_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setenv("WORKEROS_DEV", "1")
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_URL", "https://test-project.supabase.co")
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_ANON_KEY", "test-anon-key")
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
    from cryptography.fernet import Fernet
    monkeypatch.setenv("WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.delenv("WORKEROS_RATE_LIMIT_DEV", raising=False)
    psycopg = types.ModuleType("psycopg")
    psycopg.Connection = object
    psycopg.connect = lambda *_a, **_k: None
    monkeypatch.setitem(sys.modules, "psycopg", psycopg)
    for name in [
        "apps.api.startup", "apps.api.main", "main", "db", "models",
        "worker_registry", "run_service", "chat_service",
    ]:
        sys.modules.pop(name, None)
    return importlib.import_module("apps.api.main")


def _fake(method: str, path: str):
    return SimpleNamespace(method=method, url=SimpleNamespace(path=path))


def test_chat_rule_present_and_scoped(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    assert main._cloud_rate_limit_for_request(_fake("POST", "/chat")) == (20, 60.0)
    assert main._cloud_rate_limit_for_request(_fake("POST", "/api/chat")) == (20, 60.0)
    # Reads aren't throttled by this rule; an unrelated path is untouched.
    assert main._cloud_rate_limit_for_request(_fake("GET", "/chat")) is None
    assert main._cloud_rate_limit_for_request(_fake("POST", "/chat/attachments")) is None
    # Pre-existing rules still resolve (no regression).
    assert main._cloud_rate_limit_for_request(_fake("POST", "/api/novasearch/match")) == (30, 60.0)


def test_list_endpoint_scraping_rules_are_exact_roots(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    assert main._cloud_rate_limit_for_request(_fake("GET", "/api/workers")) == (240, 60.0)
    assert main._cloud_rate_limit_for_request(_fake("GET", "/workers")) == (240, 60.0)
    assert main._cloud_rate_limit_for_request(_fake("GET", "/api/connections")) == (240, 60.0)
    assert main._cloud_rate_limit_for_request(_fake("GET", "/api/workers/worker-123")) is None
    assert main._cloud_rate_limit_for_request(_fake("POST", "/api/workers")) is None


def _request(method: str, path: str, token: bytes = b"tok-abc") -> Request:
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [(b"authorization", b"Bearer " + token)],
        "client": ("1.2.3.4", 12345),
        "scheme": "https",
        "server": ("testserver", 443),
    }
    return Request(scope)


def test_chat_throttles_after_limit(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    main._cloud_rate_buckets.clear()

    async def call_next(_req):
        return Response("ok", status_code=200)

    async def run():
        out = []
        for _ in range(21):
            res = await main.cloud_rate_limit_middleware(_request("POST", "/chat"), call_next)
            out.append(res)
        return out

    responses = asyncio.run(run())
    assert [r.status_code for r in responses[:20]] == [200] * 20
    assert responses[20].status_code == 429
    assert responses[20].headers.get("Retry-After")  # present + non-empty


def test_chat_limit_is_per_identity(monkeypatch, tmp_path):
    """A second identity is not throttled by the first's bucket."""
    main = _load_main(monkeypatch, tmp_path)
    main._cloud_rate_buckets.clear()

    async def call_next(_req):
        return Response("ok", status_code=200)

    async def run():
        for _ in range(20):
            await main.cloud_rate_limit_middleware(_request("POST", "/chat", token=b"user-a"), call_next)
        # user-a is now at the limit; user-b should still pass.
        blocked_a = await main.cloud_rate_limit_middleware(_request("POST", "/chat", token=b"user-a"), call_next)
        fresh_b = await main.cloud_rate_limit_middleware(_request("POST", "/chat", token=b"user-b"), call_next)
        return blocked_a, fresh_b

    blocked_a, fresh_b = asyncio.run(run())
    assert blocked_a.status_code == 429
    assert fresh_b.status_code == 200
