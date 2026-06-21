"""#1727 — GET /connections collapses duplicate rows for the same account.

Reconnect flows could leave multiple ACTIVE rows for one (app, account), so the
list showed Gmail x2 / Google Calendar x3 for the same 'federico'. The serving
layer now dedupes by (app, kind, account-label, scopes), keeping the live +
most-recently-used row, while preserving rows with genuinely different scopes.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_app(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-composio-key")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    (tmp_path / "workers").mkdir()

    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main",
    ]:
        sys.modules.pop(name, None)
    for _rn in [x for x in list(sys.modules) if x.startswith("routers")]:
        sys.modules.pop(_rn, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    return db, main


def _seed(repos, owner, *, conn_id, app, label, scopes_json=None, ca=None,
          created_at="2026-06-01T00:00:00Z"):
    repos.connections.upsert(
        user_id=owner,
        id=conn_id,
        app_name=app,
        composio_connection_id=ca or f"ca_{conn_id}",
        status="active",
        account_label=label,
        display_name=label,
        scopes_json=scopes_json,
        created_at=created_at,
        updated_at=created_at,
    )


def _client(main):
    return TestClient(main.app, headers={"x-floom-secret": "test-secret"})


def test_duplicate_same_account_rows_collapse_to_one(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    owner = main._bootstrap_user_id()

    # Three active gmail rows + three active google calendar rows, same account.
    for i in range(3):
        _seed(repos, owner, conn_id=f"gmail-{i}", app="gmail", label="federico",
              created_at=f"2026-06-0{i+1}T00:00:00Z")
        _seed(repos, owner, conn_id=f"gcal-{i}", app="googlecalendar", label="federico",
              created_at=f"2026-06-0{i+1}T00:00:00Z")

    with _client(main) as c:
        rows = c.get("/connections").json()

    apps = [r["app_name"] for r in rows]
    assert apps.count("gmail") == 1, rows
    assert apps.count("googlecalendar") == 1, rows


def test_distinct_scopes_are_preserved(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    owner = main._bootstrap_user_id()

    _seed(repos, owner, conn_id="g-read", app="gmail", label="federico",
          scopes_json='["gmail.readonly"]')
    _seed(repos, owner, conn_id="g-send", app="gmail", label="federico",
          scopes_json='["gmail.send"]')

    with _client(main) as c:
        rows = c.get("/connections").json()

    assert [r["app_name"] for r in rows].count("gmail") == 2, rows


def test_different_accounts_are_preserved(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    owner = main._bootstrap_user_id()

    _seed(repos, owner, conn_id="g-a", app="gmail", label="a@x.com")
    _seed(repos, owner, conn_id="g-b", app="gmail", label="b@x.com")

    with _client(main) as c:
        rows = c.get("/connections").json()

    assert [r["app_name"] for r in rows].count("gmail") == 2, rows


def test_blank_label_rows_are_preserved(monkeypatch, tmp_path):
    # Two active same-app rows with NO account label must NOT collapse — a blank
    # label is "unknown account", not "same account" (mirrors the canonical
    # find_by_app_account, which refuses to merge blank labels).
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    owner = main._bootstrap_user_id()

    _seed(repos, owner, conn_id="g-blank-1", app="gmail", label=None)
    _seed(repos, owner, conn_id="g-blank-2", app="gmail", label=None)

    with _client(main) as c:
        rows = c.get("/connections").json()

    assert [r["app_name"] for r in rows].count("gmail") == 2, rows
