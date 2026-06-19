"""#837 — system.info must not leak deployment metadata to non-admins.

RCA: GET /system/info returned ``python_version`` and ``started_at`` (process
start time) to every authenticated caller — reconnaissance data that maps the
runtime for interpreter-specific exploits and restart tracking.

P2-B (security audit 2026-06-14): fully admin-gate the endpoint; members
get 403 (version+runner were also recon data, not needed by members).

Run:
    cd apps/api && python -m pytest tests/test_system_info_disclosure.py -v
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def test_member_gets_403(monkeypatch, tmp_path):
    """P2-B: non-admin members must receive 403, not any info payload."""
    from fastapi import HTTPException
    main = _load_main(monkeypatch, tmp_path)
    from auth.context import AuthContext

    with pytest.raises(HTTPException) as exc_info:
        main.system_info(auth=AuthContext(user_id="u-1", role="member", auth_method="session"))

    assert exc_info.value.status_code == 403


def test_admin_sees_full_payload(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    from auth.context import AuthContext

    info = main.system_info(
        auth=AuthContext(user_id="a-1", role="admin", auth_method="session", scopes=("admin",))
    )

    assert "python_version" in info
    assert "started_at" in info
    assert "version" in info
    assert "runner" in info
