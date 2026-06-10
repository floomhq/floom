"""#769 — an approve-time comment is persisted (in the existing `reason` column).

Reject already stored a reason; approve discarded the reviewer's note. This
verifies the approvals repo now records a comment on approve, for all the
approve paths that pass it through (run / agent_tool / destructive_delete).
"""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_SECRET = "test-secret-769"


@pytest.fixture()
def repos(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", _SECRET)
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in ["db", "db._legacy_sqlite", "db.sqlite", "db.factory",
                 "db.dependency", "db.interface"]:
        sys.modules.pop(name, None)
    sys.modules.setdefault("scheduler", types.SimpleNamespace(
        start_scheduler=lambda: None, stop_scheduler=lambda: None))
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    yield db.get_repositories()
    db.get_repositories.cache_clear()


def _seed_pending(repos, *, owner="alice", run="run-1", worker="wk-1", aid="ap-1"):
    """Insert a bare pending approval row directly (FK off on a raw connection).

    We only exercise the approve() UPDATE, which needs no real run/worker parents.
    PRAGMA foreign_keys must be set before any transaction, so use a fresh
    sqlite3 connection rather than the app's get_db() (which opens with FK on).
    """
    import os
    import sqlite3
    from db import now_iso
    conn = sqlite3.connect(os.environ["WORKEROS_DB"])
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute(
            "INSERT INTO approvals (id, run_id, worker_id, status, created_at, owner_id) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (aid, run, worker, "pending", now_iso(), owner),
        )
        conn.commit()
    finally:
        conn.close()


def test_approve_persists_comment_in_reason(repos):
    from db import now_iso
    _seed_pending(repos)
    repos.approvals.approve(
        owner_id="alice", run_id="run-1", decided_at=now_iso(),
        comment="Looks good — ship it",
    )
    row = repos.approvals.get_by_run_id(run_id="run-1")
    assert row is not None
    assert row["status"] == "approved"
    assert row["reason"] == "Looks good — ship it"


def test_approve_without_comment_leaves_reason_null(repos):
    from db import now_iso
    _seed_pending(repos)
    repos.approvals.approve(
        owner_id="alice", run_id="run-1", decided_at=now_iso(),
    )
    row = repos.approvals.get_by_run_id(run_id="run-1")
    assert row is not None
    assert row["status"] == "approved"
    assert row["reason"] is None
