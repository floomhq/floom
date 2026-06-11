"""#837 — system.info must not leak deployment metadata to non-admins.

RCA: GET /system/info returned ``python_version`` and ``started_at`` (process
start time) to every authenticated caller — reconnaissance data that maps the
runtime for interpreter-specific exploits and restart tracking.

Fix: the full payload is admin-only; members get ``version`` and ``runner``.

Run:
    cd apps/api && python -m pytest tests/test_system_info_disclosure.py -v
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
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def test_member_does_not_see_runtime_metadata(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    from auth.context import AuthContext

    info = main.system_info(auth=AuthContext(user_id="u-1", role="member", auth_method="session"))

    assert "python_version" not in info
    assert "started_at" not in info
    assert info["version"]
    assert info["runner"] == "e2b"


def test_admin_sees_full_payload(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    from auth.context import AuthContext

    info = main.system_info(
        auth=AuthContext(user_id="a-1", role="admin", auth_method="session", scopes=("admin",))
    )

    assert "python_version" in info
    assert "started_at" in info
