"""#834 — runs.watch must not hold an HTTP connection open for 10 minutes.

RCA: both runs.watch implementations (the `/mcp-tools/serve` dispatch branch
and `_mcp_call_runs_watch`) accepted ``timeout_ms`` up to 600000 and blocked
the connection while polling. With the old default rate limit an attacker
could pin ~60 concurrent connections, each generating hundreds of internal
requests — a cheap DoS.

Fix: all MCP watch waits are clamped to [1s, 30s] by the shared
``_mcp_watch_timeout_seconds`` helper; the tool schemas advertise the cap.

Run:
    cd apps/api && python -m pytest tests/test_mcp_watch_timeout_cap.py -v
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

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


def test_ten_minute_request_is_clamped_to_30s(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    assert main._mcp_watch_timeout_seconds(600000) == 30.0


def test_default_is_30s(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    assert main._mcp_watch_timeout_seconds(None) == 30.0


def test_short_timeouts_pass_through_with_1s_floor(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    assert main._mcp_watch_timeout_seconds(5000) == 5.0
    assert main._mcp_watch_timeout_seconds(10) == 1.0


def test_garbage_input_falls_back_to_cap(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    assert main._mcp_watch_timeout_seconds("not-a-number") == 30.0
    # JSON `1e999` parses to float('inf'); int(inf) raises OverflowError
    assert main._mcp_watch_timeout_seconds(float("inf")) == 30.0


def test_advertised_schemas_do_not_exceed_cap(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    watch = next(t for t in main._MCP_DEFAULT_TOOLS if t["name"] == "runs.watch")
    props = watch["inputSchema"]["properties"]["timeout_ms"]
    assert props["default"] <= 30000
    assert props.get("maximum", 0) <= 30000
