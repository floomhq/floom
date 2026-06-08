"""Tests for issue #698 — system workers must have workspace visibility.

Root cause: system workers (worker-author, workspace-agent) were persisted with
visibility=NULL (private) under the bootstrap user. Any other authenticated user
got "worker does not belong to <uuid>" when trying to run them. Fix: set
visibility='workspace' for all system_worker:true workers at persist time.
"""

import sqlite3
from pathlib import Path


def test_system_worker_flag_maps_to_workspace_visibility():
    """The source must derive visibility='workspace' from system_worker=True."""
    src = (Path(__file__).parents[1] / "main.py").read_text(encoding="utf-8")
    fn_start = src.find("def _persist_discovered_workers")
    assert fn_start != -1
    fn_body = src[fn_start: fn_start + 5000]
    assert "system_worker" in fn_body, "Must read system_worker from manifest"
    assert "'workspace'" in fn_body or '"workspace"' in fn_body, (
        "Must assign visibility='workspace' for system workers"
    )


def test_non_system_worker_maps_to_private_visibility():
    """The source must assign visibility='private' for non-system workers."""
    src = (Path(__file__).parents[1] / "main.py").read_text(encoding="utf-8")
    fn_start = src.find("def _persist_discovered_workers")
    assert fn_start != -1
    fn_body = src[fn_start: fn_start + 5000]
    assert "'private'" in fn_body or '"private"' in fn_body, (
        "Must assign visibility='private' for non-system workers"
    )


def test_worker_author_is_workspace_visible_in_db():
    """worker-author must have visibility='workspace' in the live DB."""
    db_path = Path(__file__).parents[1] / "data" / "floom.db"
    if not db_path.exists():
        import pytest; pytest.skip("No live DB found")
    conn = sqlite3.connect(str(db_path))
    row = conn.execute(
        "SELECT visibility FROM workers WHERE id = ?", ("worker-author",)
    ).fetchone()
    conn.close()
    assert row is not None, "worker-author not found in DB"
    assert row[0] == "workspace", (
        f"worker-author has visibility={row[0]!r}; must be 'workspace'"
    )


def test_workspace_agent_is_workspace_visible_in_db():
    """workspace-agent must have visibility='workspace' in the live DB."""
    db_path = Path(__file__).parents[1] / "data" / "floom.db"
    if not db_path.exists():
        import pytest; pytest.skip("No live DB found")
    conn = sqlite3.connect(str(db_path))
    row = conn.execute(
        "SELECT visibility FROM workers WHERE id = ?", ("workspace-agent",)
    ).fetchone()
    conn.close()
    assert row is not None, "workspace-agent not found in DB"
    assert row[0] == "workspace", (
        f"workspace-agent has visibility={row[0]!r}; must be 'workspace'"
    )


def test_persist_discovered_workers_includes_visibility_column():
    """The INSERT in _persist_discovered_workers must include the visibility column."""
    src = (Path(__file__).parents[1] / "main.py").read_text(encoding="utf-8")
    fn_start = src.find("def _persist_discovered_workers")
    assert fn_start != -1
    fn_body = src[fn_start: fn_start + 4000]
    assert "visibility" in fn_body, (
        "_persist_discovered_workers must include visibility in the INSERT"
    )
    assert "worker_visibility" in fn_body or "is_system_worker" in fn_body, (
        "Must derive visibility from system_worker flag"
    )
