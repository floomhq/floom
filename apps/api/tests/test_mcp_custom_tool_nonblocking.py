"""#835 — custom MCP tool execution must not block the connection for 120s.

RCA: calling a custom workspace tool via MCP triggered a worker run and then
busy-waited up to 120 seconds polling the DB, holding the HTTP connection the
whole time — concurrent custom-tool calls exhausted the connection pool.

Fix: the wait is capped at the shared 30s MCP limit (#834's
``_mcp_watch_timeout_seconds``). Fast tools still return output inline; runs
that outlive the cap return ``{"status": "running", "run_id": ...}`` as a
NON-error so the client polls runs.get / runs.watch for the result.

Run:
    cd apps/api && python -m pytest tests/test_mcp_custom_tool_nonblocking.py -v
"""
from __future__ import annotations

import asyncio
import importlib
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

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


def _fake_request():
    from starlette.requests import Request

    return Request({"type": "http", "method": "POST", "path": "/mcp-tools/serve", "query_string": b"", "headers": []})


def _fake_repos(run_status: str, output: dict | None = None, error: str | None = None):
    run_row = {
        "id": "run-1",
        "status": run_status,
        "output_json": output,
        "error": error,
    }
    return SimpleNamespace(
        mcp_tools=SimpleNamespace(get_by_name=lambda *, user_id, name: {"id": "t1", "worker_id": "w1", "name": name}),
        runs=SimpleNamespace(get=lambda *, user_id, run_id: dict(run_row)),
    )


def _dispatch(main, monkeypatch, repos):
    from auth.context import AuthContext

    monkeypatch.setattr(main, "create_run", lambda *args, **kwargs: "run-1")
    monkeypatch.setattr(main, "start_run", lambda *args, **kwargs: None)
    # shrink the wait cap so the slow-run test doesn't take 30s of wall clock
    monkeypatch.setattr(main, "_mcp_watch_timeout_seconds", lambda raw: 1.5)

    auth = AuthContext(user_id="u-1", role="member", auth_method="pat")
    return asyncio.run(main._mcp_dispatch("my_custom_tool", {}, auth, repos, _fake_request()))


def test_slow_run_returns_run_id_instead_of_blocking(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)

    started = time.monotonic()
    result = _dispatch(main, monkeypatch, _fake_repos("running"))
    elapsed = time.monotonic() - started

    assert elapsed < 10, f"dispatch blocked for {elapsed:.1f}s"
    assert result["isError"] is False
    body = json.loads(result["content"][0]["text"])
    assert body["status"] == "running"
    assert body["run_id"] == "run-1"


def test_fast_run_still_returns_output_inline(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)

    result = _dispatch(main, monkeypatch, _fake_repos("completed", output={"answer": 42}))

    assert result["isError"] is False
    assert json.loads(result["content"][0]["text"]) == {"answer": 42}


def test_completed_run_redacts_secret_shaped_output(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    leaked_token = "tok_live_1234567890abcdef"
    leaked_bearer = "Bearer abcdefghijklmnop"

    result = _dispatch(
        main,
        monkeypatch,
        _fake_repos(
            "completed",
            output={
                "message": f"done token={leaked_token} auth {leaked_bearer}",
                "api_key": "sk-live-secret-value",
                "url": f"https://example.com/callback?token={leaked_token}&ok=1",
            },
        ),
    )
    text = result["content"][0]["text"]

    assert result["isError"] is False
    assert leaked_token not in text
    assert leaked_bearer not in text
    assert "sk-live-secret-value" not in text
    assert "token=[redacted]" in text
    assert "Bearer [redacted]" in text


def test_failed_run_is_error(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)

    result = _dispatch(main, monkeypatch, _fake_repos("failed", error="boom"))

    assert result["isError"] is True
    assert "boom" in result["content"][0]["text"]


def test_failed_run_redacts_secret_shaped_error(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    leaked_token = "errtok_1234567890abcdef"
    leaked_bearer = "Bearer zyxwvutsrqponmlk"

    result = _dispatch(
        main,
        monkeypatch,
        _fake_repos("failed", error=f"failed api_key={leaked_token} {leaked_bearer}"),
    )
    text = result["content"][0]["text"]

    assert result["isError"] is True
    assert leaked_token not in text
    assert leaked_bearer not in text
    assert "api_key=[redacted]" in text
    assert "Bearer [redacted]" in text
