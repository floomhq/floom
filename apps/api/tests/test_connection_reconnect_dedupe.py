"""Tests for the Composio connection sign-in flow improvements (X9 + N5-1).

Covers:
  - Reconnecting the SAME app + SAME account merges into the existing canonical
    row (no duplicate; count stays 1, canonical id is stable).
  - Connecting a NEW account of an already-connected app adds a second row.
  - The callback redirect carries app + canonical connection_id so the UI can
    render post-connect feedback and highlight the new row.
  - GET /connections/by-app/<app> reports the already-connected account(s).
  - find_by_app_account repo helper returns the OLDEST canonical row.
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
    monkeypatch.setenv("WORKERS_FRONTEND_URL", "https://workers.example.test")
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

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    return db, main


def _seed_active(repos, owner, *, conn_id, ca_id, account_label, created_at="2026-06-01T00:00:00Z"):
    repos.connections.upsert(
        user_id=owner,
        id=conn_id,
        app_name="gmail",
        composio_connection_id=ca_id,
        status="active",
        account_label=account_label,
        created_at=created_at,
        updated_at=created_at,
    )


def test_find_by_app_account_returns_oldest(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    owner = main._bootstrap_user_id()

    _seed_active(repos, owner, conn_id="old", ca_id="ca_old", account_label="a@b.com",
                 created_at="2026-06-01T00:00:00Z")
    _seed_active(repos, owner, conn_id="new", ca_id="ca_new", account_label="A@B.com",
                 created_at="2026-06-02T00:00:00Z")

    # Case-insensitive label match; excludes the row passed as exclude_id;
    # returns the oldest canonical row.
    found = repos.connections.find_by_app_account(
        user_id=owner, app_name="GMAIL", account_label="a@b.com", exclude_id="new"
    )
    assert found is not None
    assert found["id"] == "old"

    # No match for an unknown account.
    assert (
        repos.connections.find_by_app_account(
            user_id=owner, app_name="gmail", account_label="nobody@x.com"
        )
        is None
    )
    # Blank label never matches (avoids merging placeholder rows together).
    assert (
        repos.connections.find_by_app_account(
            user_id=owner, app_name="gmail", account_label=""
        )
        is None
    )


def test_reconnect_same_account_no_duplicate(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    owner = main._bootstrap_user_id()

    # Canonical row already connected as alice@example.com.
    _seed_active(repos, owner, conn_id="canon", ca_id="ca_first", account_label="alice@example.com")

    # User starts a reconnect: initiate creates a fresh row (as production does).
    repos.connections.upsert(
        user_id=owner,
        id="reconnect-row",
        app_name="gmail",
        composio_connection_id="ca_second",
        status="initiated",
        created_at="2026-06-03T00:00:00Z",
        updated_at="2026-06-03T00:00:00Z",
    )

    # Composio resolves the new account to the SAME email -> dedupe must merge.
    monkeypatch.setattr(
        main, "_fetch_composio_account_info",
        lambda cid, *, user_id: {"email": "alice@example.com", "scopes": ["a", "b"]},
    )
    monkeypatch.setattr(main, "_normalize_composio_connection_status", lambda s: "active")
    import composio_client
    monkeypatch.setattr(composio_client, "check_status", lambda cid: "active")

    client = TestClient(main.app)
    resp = client.get(
        "/connections/callback",
        params={"connection_id": "ca_second", "status": "active"},
        follow_redirects=False,
    )
    assert resp.status_code in (302, 307)
    location = resp.headers["location"]

    # Post-connect feedback payload: app slug + the CANONICAL floom id.
    assert "connected=1" in location
    assert "app=gmail" in location
    assert "connection_id=canon" in location

    # Exactly ONE row survives for (owner, gmail) and it is the canonical one,
    # now pointing at the freshly authorized Composio account.
    rows = repos.connections.list(user_id=owner)
    gmail_rows = [r for r in rows if r["app_name"] == "gmail"]
    assert len(gmail_rows) == 1
    survivor = gmail_rows[0]
    assert survivor["id"] == "canon"
    assert survivor["composio_connection_id"] == "ca_second"
    assert survivor["status"] == "active"
    assert survivor["account_label"] == "alice@example.com"


def test_connect_new_account_adds_row(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    owner = main._bootstrap_user_id()

    _seed_active(repos, owner, conn_id="canon", ca_id="ca_first", account_label="alice@example.com")

    # New, distinct account authorized.
    repos.connections.upsert(
        user_id=owner,
        id="second-row",
        app_name="gmail",
        composio_connection_id="ca_second",
        status="initiated",
        created_at="2026-06-03T00:00:00Z",
        updated_at="2026-06-03T00:00:00Z",
    )

    monkeypatch.setattr(
        main, "_fetch_composio_account_info",
        lambda cid, *, user_id: {"email": "bob@example.com", "scopes": []},
    )
    monkeypatch.setattr(main, "_normalize_composio_connection_status", lambda s: "active")
    import composio_client
    monkeypatch.setattr(composio_client, "check_status", lambda cid: "active")

    client = TestClient(main.app)
    resp = client.get(
        "/connections/callback",
        params={"connection_id": "ca_second", "status": "active"},
        follow_redirects=False,
    )
    assert resp.status_code in (302, 307)
    # Lands on the NEW row (no merge happened).
    assert "connection_id=second-row" in resp.headers["location"]

    rows = repos.connections.list(user_id=owner)
    gmail_rows = sorted(r["id"] for r in rows if r["app_name"] == "gmail")
    assert gmail_rows == ["canon", "second-row"]


def test_by_app_reports_existing_connection(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    owner = main._bootstrap_user_id()

    _seed_active(repos, owner, conn_id="canon", ca_id="ca_first", account_label="alice@example.com")

    client = TestClient(main.app)
    resp = client.get(
        "/connections/by-app/gmail", headers={"x-floom-secret": "test-secret"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["connected"] is True
    assert body["app_name"] == "gmail"
    assert body["accounts"][0]["account_label"] == "alice@example.com"
    assert body["accounts"][0]["id"] == "canon"

    # Unconnected app reports not connected.
    resp2 = client.get(
        "/connections/by-app/notion", headers={"x-floom-secret": "test-secret"}
    )
    assert resp2.status_code == 200
    assert resp2.json() == {"connected": False}
