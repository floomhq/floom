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


def test_mcp_serve_has_strict_rate_limit(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    assert main._rate_limit_for_path("/mcp-tools/serve") == (10, 60.0)


def test_unmatched_paths_keep_default(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    assert main._rate_limit_for_path("/some/other/path") == main.DEFAULT_RATE_LIMIT
