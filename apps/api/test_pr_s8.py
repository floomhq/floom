"""PR S8 backend tests.

Tests:
  1. _get_timeseries_batch: 14-day zero-fill with correct counts.
  2. DraftFromPromptResponse: files[] field shape is valid in the response model.
"""

import datetime
import os
import sqlite3
import tempfile
from contextlib import contextmanager
from types import SimpleNamespace
from typing import Generator, Dict, List, Any
from unittest.mock import patch, MagicMock

import pytest


# ---------------------------------------------------------------------------
# Helpers -- build an in-memory SQLite connection with runs data
# ---------------------------------------------------------------------------

def _make_in_memory_db_with_runs() -> sqlite3.Connection:
    """Create an in-memory SQLite connection with a minimal runs table."""
    conn = sqlite3.connect(":memory:", detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE workers (
            id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE runs (
            id TEXT PRIMARY KEY,
            worker_id TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    conn.execute("INSERT INTO workers VALUES (?, ?)", ("worker-a", "test-user"))
    conn.execute("INSERT INTO workers VALUES (?, ?)", ("worker-b", "test-user"))

    today = datetime.date.today()

    # 3 completed + 1 failed run today for worker-a
    for i in range(3):
        conn.execute(
            "INSERT INTO runs VALUES (?, ?, ?, ?)",
            (f"run-a-ok-{i}", "worker-a", "completed", today.isoformat() + "T10:00:00"),
        )
    conn.execute(
        "INSERT INTO runs VALUES (?, ?, ?, ?)",
        ("run-a-fail", "worker-a", "failed", today.isoformat() + "T11:00:00"),
    )

    # 2 completed runs 5 days ago for worker-a
    five_ago = (today - datetime.timedelta(days=5)).isoformat()
    for i in range(2):
        conn.execute(
            "INSERT INTO runs VALUES (?, ?, ?, ?)",
            (f"run-a-old-{i}", "worker-a", "completed", five_ago + "T09:00:00"),
        )

    # 1 completed run today for worker-b
    conn.execute(
        "INSERT INTO runs VALUES (?, ?, ?, ?)",
        ("run-b-1", "worker-b", "completed", today.isoformat() + "T08:00:00"),
    )

    conn.commit()
    return conn


@contextmanager
def _ctx_manager_from_conn(conn: sqlite3.Connection):
    """Wrap a live connection as a context manager (yields same conn, no-op on exit)."""
    yield conn


def _repos():
    from db.sqlite import SqliteWorkerRepository

    return SimpleNamespace(workers=SqliteWorkerRepository())


# ---------------------------------------------------------------------------
# Import main after DB init is already done (it runs at module load time
# in the real app). We patch get_db ONLY for the function under test.
# ---------------------------------------------------------------------------

# We need main imported; the init_db() runs on the real data dir (or creates
# a minimal DB). The functions we test (_get_timeseries_batch, DraftFile,
# DraftFromPromptResponse) are pure enough once we mock get_db.

import main as _main_module  # noqa: E402  -- imported after helpers defined


# ---------------------------------------------------------------------------
# 1. Timeseries batch -- 14-day zero-fill
# ---------------------------------------------------------------------------

def test_timeseries_zero_fill_14_days() -> None:
    """_get_timeseries_batch returns exactly 14 entries per worker, zero-filled."""
    conn = _make_in_memory_db_with_runs()

    def fake_get_db():
        return _ctx_manager_from_conn(conn)

    repos = _repos()
    with patch("db.sqlite.get_db", fake_get_db):
        result = _main_module._get_timeseries_batch(
            ["worker-a", "worker-b"],
            user_id="test-user",
            repos=repos,
            days=14,
        )

    assert "worker-a" in result
    assert "worker-b" in result

    days_a = result["worker-a"]
    assert len(days_a) == 14, f"Expected 14 days, got {len(days_a)}"

    today = datetime.date.today()

    # Last entry = today
    last = days_a[-1]
    assert last.date == today.isoformat()
    assert last.completed == 3
    assert last.failed == 1
    assert last.total == 4

    # Entry for 5 days ago
    five_ago = (today - datetime.timedelta(days=5)).isoformat()
    five_ago_entry = next((d for d in days_a if d.date == five_ago), None)
    assert five_ago_entry is not None
    assert five_ago_entry.completed == 2
    assert five_ago_entry.failed == 0
    assert five_ago_entry.total == 2

    # All other days are zero-filled
    for day in days_a:
        if day.date not in (today.isoformat(), five_ago):
            assert day.total == 0, f"Expected 0 total on {day.date}, got {day.total}"
            assert day.completed == 0
            assert day.failed == 0

    # worker-b has only today's run
    days_b = result["worker-b"]
    assert len(days_b) == 14
    today_b = days_b[-1]
    assert today_b.completed == 1
    zero_days = [d for d in days_b if d.date != today.isoformat()]
    assert all(d.total == 0 for d in zero_days)


def test_timeseries_unknown_worker_returns_all_zeros() -> None:
    """Unknown worker ID returns 14 zero-filled days (not an error)."""
    conn = _make_in_memory_db_with_runs()

    def fake_get_db():
        return _ctx_manager_from_conn(conn)

    repos = _repos()
    with patch("db.sqlite.get_db", fake_get_db):
        result = _main_module._get_timeseries_batch(
            ["nonexistent-worker"],
            user_id="test-user",
            repos=repos,
            days=14,
        )

    assert "nonexistent-worker" in result
    days = result["nonexistent-worker"]
    assert len(days) == 14
    assert all(d.total == 0 for d in days)


def test_timeseries_empty_worker_ids() -> None:
    """Empty worker_ids returns empty dict without hitting DB."""
    result = _main_module._get_timeseries_batch(
        [],
        user_id="test-user",
        repos=SimpleNamespace(workers=object()),
        days=14,
    )
    assert result == {}


def test_timeseries_days_param() -> None:
    """Custom days parameter returns the requested number of entries."""
    conn = _make_in_memory_db_with_runs()

    def fake_get_db():
        return _ctx_manager_from_conn(conn)

    repos = _repos()
    with patch("db.sqlite.get_db", fake_get_db):
        result7 = _main_module._get_timeseries_batch(
            ["worker-a"],
            user_id="test-user",
            repos=repos,
            days=7,
        )
        result30 = _main_module._get_timeseries_batch(
            ["worker-a"],
            user_id="test-user",
            repos=repos,
            days=30,
        )

    assert len(result7["worker-a"]) == 7
    assert len(result30["worker-a"]) == 30


# ---------------------------------------------------------------------------
# 2. DraftFromPromptResponse: files[] field shape
# ---------------------------------------------------------------------------

def test_draft_response_has_files_field() -> None:
    """DraftFromPromptResponse model accepts and serialises files[] correctly."""
    DraftFromPromptResponse = _main_module.DraftFromPromptResponse
    DraftFile = _main_module.DraftFile

    resp = DraftFromPromptResponse(
        worker_yml="id: test\nname: Test",
        suggested_name="test",
        suggested_title="Test",
        required_connections=[],
        required_secrets=[],
        inputs=[],
        outputs=[],
        files=[
            DraftFile(path="worker.yml", content="id: test\nname: Test"),
            DraftFile(path="SKILL.md", content="# Test Skill"),
            DraftFile(path="run.py", content="def run(): pass"),
        ],
    )

    assert len(resp.files) == 3
    paths = [f.path for f in resp.files]
    assert "worker.yml" in paths
    assert "SKILL.md" in paths
    assert "run.py" in paths

    # Check serialization to dict (simulates JSON response)
    data = resp.model_dump()
    assert "files" in data
    assert len(data["files"]) == 3
    assert data["files"][0] == {"path": "worker.yml", "content": "id: test\nname: Test"}


def test_draft_response_files_defaults_to_empty() -> None:
    """DraftFromPromptResponse.files defaults to [] when not provided."""
    DraftFromPromptResponse = _main_module.DraftFromPromptResponse

    resp = DraftFromPromptResponse(
        worker_yml="id: test\nname: Test",
        suggested_name="test",
        suggested_title="Test",
        required_connections=[],
        required_secrets=[],
        inputs=[],
        outputs=[],
    )

    assert resp.files == []
    data = resp.model_dump()
    assert data["files"] == []


def test_draft_file_path_and_content_are_strings() -> None:
    """DraftFile stores path and content as strings."""
    DraftFile = _main_module.DraftFile

    f = DraftFile(path="lib/helper.py", content="# helper")
    assert f.path == "lib/helper.py"
    assert f.content == "# helper"


def test_draft_files_subpaths_are_preserved() -> None:
    """DraftFile preserves subdirectory paths."""
    DraftFile = _main_module.DraftFile

    f = DraftFile(path="lib/client/api.py", content="pass")
    assert f.path == "lib/client/api.py"
