"""#839 — /mcp-tools/serve must have an explicit (strict) rate-limit rule.

RCA: no rule in RATE_LIMIT_RULES matched ``/mcp-tools/serve``, so it fell back
to DEFAULT_RATE_LIMIT (60/min) — generous enough for brute-forcing a weak
secret or pinning connections via runs.watch.

Fix: explicit rule ``^/mcp-tools/serve$ -> (10, 60.0)``, in line with the
other sensitive endpoints.

Run:
    cd apps/api && python -m pytest tests/test_mcp_serve_rate_limit.py -v
"""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth.") or name.startswith("routers"):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def test_mcp_serve_has_strict_rate_limit(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    assert main._rate_limit_for_path("/mcp-tools/serve") == (10, 60.0)


def test_unmatched_paths_keep_default(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    assert main._rate_limit_for_path("/some/other/path") == main.DEFAULT_RATE_LIMIT


def _mcp_request(client):
    return client.post(
        "/mcp-tools/serve",
        content=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
        headers={"x-floom-secret": "rate-limit-test-secret"},
    )


def test_mcp_rate_limit_signals_and_fixed_window(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOOM_SECRET", "rate-limit-test-secret")
    main = _load_main(monkeypatch, tmp_path)
    main._rate_buckets.clear()
    clock = [1_000.0]
    monkeypatch.setattr(main.time, "time", lambda: clock[0])

    with TestClient(main.app) as client:
        for _ in range(10):
            assert _mcp_request(client).status_code == 200

        rejected = _mcp_request(client)
        assert rejected.status_code == 429
        detail = rejected.json()["detail"]
        assert detail == {
            "error_code": "rate_limit_exceeded",
            "message": "Rate limit exceeded",
            "retry_after": 60,
            "scope": "per-workspace",
            "limit": 10,
            "remaining": 0,
        }
        assert rejected.headers["Retry-After"] == "60"
        assert rejected.headers["X-RateLimit-Scope"] == "per-workspace"
        assert rejected.headers["RateLimit-Limit"] == "10"
        assert rejected.headers["RateLimit-Remaining"] == "0"

        # Repeated rejected calls do not move the fixed window's expiry.
        clock[0] += 20
        assert _mcp_request(client).headers["Retry-After"] == "40"
        clock[0] += 20
        assert _mcp_request(client).headers["Retry-After"] == "20"

        # Waiting the advertised remainder frees the window.
        clock[0] += 20
        assert _mcp_request(client).status_code == 200
