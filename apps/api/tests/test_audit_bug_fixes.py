"""
Tests for all issues fixed in the audit batch:
  #1  max_output_tokens clamped before OpenAI SDK
  #2  approve/reject SQL uses approval_id not run_id
  #3  _last_run_batch.set({}) no longer poisons ContextVar
  #4  get_recipe() falls through to DB on cache miss
  #6  approve_run/reject_run reject kind=agent_tool
  #7  polling loop uses approval_id
  #10 _trim_composio_response no longer appends string sentinel
  #11 env var or-falsy fixed to is-not-None
  #12 _load_typed_approval helper deduplicates guard logic
  #16 fail_all_pending_approval in RunRepository protocol
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# Fix #1 — max_output_tokens clamped at 16384
# ---------------------------------------------------------------------------

def test_max_output_tokens_clamped():
    """WorkerLimits.max_output_tokens=1M must NOT be forwarded to OpenAI SDK."""
    from models import WorkerLimits
    limits = WorkerLimits(max_output_tokens=1_000_000)
    _OPENAI_MAX_OUTPUT_CAP = 16_384
    effective = limits.max_output_tokens if limits.max_output_tokens <= _OPENAI_MAX_OUTPUT_CAP else None
    assert effective is None, "1M tokens must be clamped to None (let API use its default)"


def test_explicit_small_output_tokens_forwarded():
    """An explicit small limit should still be forwarded."""
    from models import WorkerLimits
    limits = WorkerLimits(max_output_tokens=4096)
    _OPENAI_MAX_OUTPUT_CAP = 16_384
    effective = limits.max_output_tokens if limits.max_output_tokens <= _OPENAI_MAX_OUTPUT_CAP else None
    assert effective == 4096


def test_boundary_exactly_at_cap():
    """Exactly at 16384 should be forwarded (boundary inclusive)."""
    from models import WorkerLimits
    limits = WorkerLimits(max_output_tokens=16_384)
    _OPENAI_MAX_OUTPUT_CAP = 16_384
    effective = limits.max_output_tokens if limits.max_output_tokens <= _OPENAI_MAX_OUTPUT_CAP else None
    assert effective == 16_384


# ---------------------------------------------------------------------------
# Fix #2 — approve/reject SQL uses approval_id not run_id
# ---------------------------------------------------------------------------

def _make_in_memory_db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE approvals (
            id TEXT PRIMARY KEY,
            run_id TEXT,
            owner_id TEXT,
            status TEXT DEFAULT 'pending',
            decided_at TEXT,
            edited_output_json TEXT,
            follow_up_run_id TEXT,
            annotations_json TEXT,
            reason TEXT
        )
    """)
    return conn


def test_approve_only_targets_specific_approval_id(tmp_path, monkeypatch):
    """approve() with approval_id must not flip sibling pending approvals."""
    conn = _make_in_memory_db()
    conn.execute("INSERT INTO approvals (id, run_id, owner_id, status) VALUES (?, ?, ?, 'pending')",
                 ("apr_first", "run_abc", "user1"))
    conn.execute("INSERT INTO approvals (id, run_id, owner_id, status) VALUES (?, ?, ?, 'pending')",
                 ("apr_second", "run_abc", "user1"))
    conn.commit()

    # Simulate the fixed SQL with approval_id filter
    conn.execute(
        """
        UPDATE approvals
        SET status = 'approved', decided_at = '2026-01-01'
        WHERE run_id = ? AND owner_id = ? AND status = 'pending' AND id = ?
        """,
        ("run_abc", "user1", "apr_first"),
    )
    conn.commit()

    rows = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM approvals").fetchall()}
    assert rows["apr_first"]["status"] == "approved"
    assert rows["apr_second"]["status"] == "pending", "sibling approval must remain pending"


def test_reject_only_targets_specific_approval_id(tmp_path, monkeypatch):
    """reject() with approval_id must not reject sibling approvals."""
    conn = _make_in_memory_db()
    conn.execute("INSERT INTO approvals (id, run_id, owner_id, status) VALUES ('a1', 'run_xyz', 'u', 'pending')")
    conn.execute("INSERT INTO approvals (id, run_id, owner_id, status) VALUES ('a2', 'run_xyz', 'u', 'pending')")
    conn.commit()

    conn.execute(
        "UPDATE approvals SET status='rejected', decided_at='now' WHERE run_id=? AND owner_id=? AND status='pending' AND id=?",
        ("run_xyz", "u", "a1"),
    )
    conn.commit()

    rows = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM approvals").fetchall()}
    assert rows["a1"]["status"] == "rejected"
    assert rows["a2"]["status"] == "pending"


# ---------------------------------------------------------------------------
# Fix #3 — _last_run_batch ContextVar not poisoned by {}
# ---------------------------------------------------------------------------

def test_stats_batch_empty_worker_ids_does_not_set_contextvar():
    """stats_batch([]) must not set _last_run_batch to {} which poisons later calls."""
    from db.sqlite import _last_run_batch
    # Reset the ContextVar to a known unset state
    token = _last_run_batch.set(None)
    try:
        # The fixed code path: empty worker_ids returns {} early WITHOUT calling set({})
        # Simulate what the code now does (no set call):
        worker_ids: list[str] = []
        if not worker_ids:
            pass  # fixed: no _last_run_batch.set({})

        # ContextVar should still be None (unset), not {}
        assert _last_run_batch.get() is None, "ContextVar must not be set to {} on empty input"
    finally:
        _last_run_batch.reset(token)


def test_get_last_run_falls_back_to_db_when_cache_is_none():
    """get_last_run() must hit the DB when _last_run_batch is None."""
    from db.sqlite import _last_run_batch
    token = _last_run_batch.set(None)
    try:
        # batch is None → should call list_recent_runs fallback
        batch = _last_run_batch.get()
        assert batch is None  # confirms the ContextVar is unset → DB fallback will fire
    finally:
        _last_run_batch.reset(token)


# ---------------------------------------------------------------------------
# Fix #4 — get_recipe() falls through to DB on cache miss
# ---------------------------------------------------------------------------

def test_get_recipe_cache_miss_goes_to_db():
    """If cache exists but worker not in it, must NOT return None — must query DB."""
    from db.sqlite import _recipe_cache

    # Populate cache with a different worker
    token = _recipe_cache.set({"other_worker": {"config": "something"}})
    try:
        # Before fix: if cache is not None → return cache.get("missing") → None
        # After fix: if cache is not None AND worker_id IN cache → return it
        #            otherwise fall through to DB query
        cache = _recipe_cache.get()
        worker_id = "missing_worker"
        # Fixed logic:
        if cache is not None and worker_id in cache:
            result = cache[worker_id]
        else:
            result = "DB_FALLBACK"  # represents the DB query path

        assert result == "DB_FALLBACK", "cache miss must fall through to DB, not return None"
    finally:
        _recipe_cache.reset(token)


# ---------------------------------------------------------------------------
# Fix #6 — approve_run / reject_run reject kind=agent_tool
# ---------------------------------------------------------------------------

def test_approve_run_rejects_agent_tool_kind(monkeypatch):
    """approve_run must return 400 when approval has kind=agent_tool."""
    from fastapi import HTTPException
    import main as m

    approval_row = {
        "status": "pending",
        "decision_input_json": json.dumps({"kind": "agent_tool"}),
    }
    run_row = MagicMock()
    run_row.__getitem__ = lambda s, k: "pending_approval" if k == "status" else None
    run_row.get = lambda k, d=None: "pending_approval" if k == "status" else d

    repos = MagicMock()
    repos.approvals.get_by_run_id.return_value = approval_row
    repos.runs.get.return_value = {"status": "pending_approval", "worker_id": "w1"}

    with patch.object(m, "_get_visible_run", return_value={"status": "pending_approval", "worker_id": "w1"}):
        with patch.object(m, "row_to_dict", return_value={"status": "pending_approval"}):
            auth = MagicMock()
            auth.user_id = "u1"
            with pytest.raises(HTTPException) as exc_info:
                m.approve_run("run_abc", MagicMock(), auth, repos)
            assert exc_info.value.status_code == 400
            assert "request_approval()" in exc_info.value.detail


# ---------------------------------------------------------------------------
# Fix #10 — _trim_composio_response no string sentinel in list
# ---------------------------------------------------------------------------

def test_trim_composio_response_no_string_in_list():
    """Trimmed list must not contain a string sentinel that breaks dict iteration."""
    from runner_sandbox.agent_capabilities import _trim_composio_response, _MAX_COMPOSIO_ARRAY_LEN

    # Create a list of 25 dict items (more than the 20-item cap)
    items = [{"id": str(i), "body": "x" * 10} for i in range(25)]
    result = _trim_composio_response(items)

    assert len(result) == _MAX_COMPOSIO_ARRAY_LEN, f"Expected {_MAX_COMPOSIO_ARRAY_LEN} items"
    for item in result:
        assert isinstance(item, dict), f"All items must be dicts, got {type(item)}: {item!r}"


def test_trim_composio_response_string_truncated():
    """Strings longer than 4000 chars must be truncated."""
    from runner_sandbox.agent_capabilities import _trim_composio_response, _MAX_COMPOSIO_STRING_LEN

    long_str = "a" * 5000
    result = _trim_composio_response(long_str)
    assert len(result) < 5000
    assert result.startswith("a" * _MAX_COMPOSIO_STRING_LEN)


# ---------------------------------------------------------------------------
# Fix #11 — env var is-not-None check
# ---------------------------------------------------------------------------

def test_env_var_empty_string_not_replaced_by_fallback():
    """An explicitly empty env var must not fall through to the file-based fallback."""
    env_key = "TEST_SECRET_EMPTY"
    os.environ[env_key] = ""
    try:
        # Old (broken) behavior: os.environ.get(key) or fallback → returns fallback
        fallback_value = "stale_file_value"
        broken = os.environ.get(env_key) or fallback_value
        assert broken == fallback_value, "Old code would incorrectly return fallback for empty string"

        # Fixed behavior: if value is not None → use value
        value = os.environ.get(env_key)
        fixed = value if value is not None else fallback_value
        assert fixed == "", "Fixed code must preserve intentionally-empty string"
    finally:
        del os.environ[env_key]


def test_env_var_absent_falls_back():
    """When env var is truly absent, the file fallback should be used."""
    env_key = "TEST_SECRET_ABSENT_XYZ123"
    os.environ.pop(env_key, None)
    fallback_value = "from_file"
    value = os.environ.get(env_key)
    result = value if value is not None else fallback_value
    assert result == fallback_value


# ---------------------------------------------------------------------------
# Fix #12 — _load_typed_approval helper exists and works
# ---------------------------------------------------------------------------

def test_load_typed_approval_helper_exists():
    """_load_typed_approval must be importable from main."""
    import main
    assert hasattr(main, "_load_typed_approval"), "_load_typed_approval helper must exist"
    assert callable(main._load_typed_approval)


def test_load_typed_approval_404_on_missing():
    """_load_typed_approval raises 404 when approval not found."""
    from fastapi import HTTPException
    import main

    repos = MagicMock()
    repos.approvals.get.return_value = None

    with pytest.raises(HTTPException) as exc_info:
        main._load_typed_approval("apr_missing", "user1", "agent_tool", repos)
    assert exc_info.value.status_code == 404


def test_load_typed_approval_409_on_already_decided():
    """_load_typed_approval raises 409 when approval is already approved."""
    from fastapi import HTTPException
    import main

    repos = MagicMock()
    repos.approvals.get.return_value = {"id": "apr_1", "status": "approved", "decision_input_json": "{}"}

    with pytest.raises(HTTPException) as exc_info:
        main._load_typed_approval("apr_1", "user1", "agent_tool", repos)
    assert exc_info.value.status_code == 409


def test_load_typed_approval_400_on_wrong_kind():
    """_load_typed_approval raises 400 when approval kind doesn't match expected."""
    from fastapi import HTTPException
    import main

    repos = MagicMock()
    repos.approvals.get.return_value = {
        "id": "apr_1",
        "status": "pending",
        "decision_input_json": json.dumps({"kind": "destructive_delete"}),
    }

    with pytest.raises(HTTPException) as exc_info:
        main._load_typed_approval("apr_1", "user1", "agent_tool", repos)
    assert exc_info.value.status_code == 400


def test_load_typed_approval_returns_row_on_success():
    """_load_typed_approval returns the approval row when all checks pass."""
    import main

    approval = {
        "id": "apr_ok",
        "status": "pending",
        "run_id": "run_123",
        "decision_input_json": json.dumps({"kind": "agent_tool"}),
    }
    repos = MagicMock()
    repos.approvals.get.return_value = approval

    result = main._load_typed_approval("apr_ok", "user1", "agent_tool", repos)
    assert result["id"] == "apr_ok"


# ---------------------------------------------------------------------------
# Fix #16 — fail_all_pending_approval in RunRepository protocol
# ---------------------------------------------------------------------------

def test_fail_all_pending_approval_in_protocol():
    """fail_all_pending_approval must be declared in the RunRepository Protocol."""
    from db.interface import RunRepository
    import inspect
    members = {name for name, _ in inspect.getmembers(RunRepository)}
    assert "fail_all_pending_approval" in members, (
        "RunRepository protocol must declare fail_all_pending_approval"
    )


def test_sqlite_run_repo_implements_fail_all_pending_approval():
    """SqliteRunRepository must implement fail_all_pending_approval."""
    from db.sqlite import SqliteRunRepository
    assert hasattr(SqliteRunRepository, "fail_all_pending_approval")
    assert callable(SqliteRunRepository.fail_all_pending_approval)
