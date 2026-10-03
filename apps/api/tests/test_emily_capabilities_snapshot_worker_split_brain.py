"""#1205 - Emily's capabilities snapshot must match the grid's worker set.

Live regression (2026-07-19): in a fresh workspace with ZERO configured
workers, Emily's chat replies described morning-brief/inbox automations as
already set up. Root cause: ``_build_capabilities_snapshot`` (baked into
Emily's system prompt every turn) enumerated workers via a raw
``repos.workers.list(user_id=user_id)`` call, a THIRD worker-enumeration path
that bypassed ``services.worker_access.list_operator_workers``, the single
source of truth the dashboard grid and Emily's own ``workers__list_all`` tool
already route through (#2270, see test_emily_worker_split_brain_round09.py).
The raw call passed no ``role``, so the repo used its "legacy default"
(owner-only, no archived filter) instead of the caller's real grid-equivalent
role, so the snapshot could disagree with what the grid (and the user) sees.

Fix: ``_build_capabilities_snapshot`` now resolves the caller's worker set via
``list_operator_workers`` with the same role resolution
``_tool_workers_list_all`` uses, so the two can never disagree again.

Run:
    cd apps/api && python -m pytest tests/test_emily_capabilities_snapshot_worker_split_brain.py -v
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_NOW = "2026-01-01T00:00:00Z"


def _load_modules(monkeypatch, db_path: Path):
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    # Same isolation as the round-09 fixture: point WORKERS_DIR at an empty
    # dir so this unit fixture only exercises the DB rows it seeds, not the
    # real on-disk stock worker catalog.
    workers_dir = db_path.parent / "workers-empty"
    workers_dir.mkdir(exist_ok=True)
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    for name in list(sys.modules):
        if (
            name in ("chat_service", "worker_registry", "runner_utils")
            or name == "db"
            or name.startswith("db.")
        ):
            sys.modules.pop(name, None)
    import db
    db.init_db()
    import chat_service
    return db, chat_service


def _user(c, uid, role):
    c.execute(
        "INSERT OR REPLACE INTO users (id,username,role,disabled,password_hash,created_at,updated_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (uid, uid, role, 0, "x", _NOW, _NOW),
    )


def _member(c, ws, uid, role):
    c.execute(
        "INSERT INTO workspace_members (workspace_id,user_id,role,status,created_at,updated_at) "
        "VALUES (?,?,?,?,?,?)",
        (ws, uid, role, "active", _NOW, _NOW),
    )


def _sv(c, svid, manifest):
    c.execute(
        "INSERT INTO skill_versions (id,name,version,manifest_json,bundle_path,created_at) "
        "VALUES (?,?,?,?,?,?)",
        (svid, svid, "1.0", json.dumps(manifest), "/x", _NOW),
    )


def _worker(c, wid, svid, owner, ws, vis, enabled=1):
    c.execute(
        "INSERT INTO workers (id,skill_version_id,name,owner_id,workspace_id,visibility,enabled,created_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (wid, svid, wid, owner, ws, vis, enabled, _NOW),
    )


def _workers_line(snapshot: str) -> str:
    match = re.search(r"^- Workers: (.+)$", snapshot, flags=re.MULTILINE)
    assert match, f"no '- Workers:' line in snapshot:\n{snapshot}"
    return match.group(1)


def _worker_count(snapshot: str) -> int:
    """Parse the leading integer out of the '- Workers: N' or
    '- Workers: N total; enabled: ...' line (see _build_capabilities_snapshot's
    worker_str formatting)."""
    line = _workers_line(snapshot)
    match = re.match(r"^(\d+)", line)
    assert match, f"could not parse worker count from: {line!r}"
    return int(match.group(1))


def test_fresh_workspace_snapshot_reports_zero_workers(tmp_path, monkeypatch):
    """A workspace with no owned workers must never see phantom automations.

    Mirrors the live #1205 repro: a brand-new member with zero workers of
    their own, but SEEDED stock/example workers exist in the DB owned by a
    different (vendor) identity. Those must not leak into the snapshot the
    same way they must not leak into the grid or workers__list_all.
    """
    db = tmp_path / "fresh.db"
    dbmod, cs = _load_modules(monkeypatch, db)

    c = sqlite3.connect(db)
    _user(c, "op-1", "member")
    _user(c, "vendor", "admin")
    _member(c, "local-default", "op-1", "owner")
    _sv(c, "sv-csv", {"title": "CSV Enricher", "is_example": True})
    _worker(c, "csv_enricher", "sv-csv", "vendor", "seed-ws", "public")
    _sv(c, "sv-mb", {"title": "Morning Brief"})
    _worker(c, "morning-brief", "sv-mb", "vendor", "seed-ws", "public")
    c.commit()
    c.close()

    grid_rows = dbmod.get_repositories().workers.list(user_id="op-1", role="member")
    assert grid_rows == []

    snapshot = cs._build_capabilities_snapshot("op-1")
    workers_line = _workers_line(snapshot)
    assert workers_line == "0", f"expected 0 workers, got: {workers_line!r}\n{snapshot}"
    assert "morning-brief" not in snapshot.lower()
    assert "csv enricher" not in snapshot.lower()


def test_capabilities_snapshot_count_matches_grid_seeded_stock_excluded(tmp_path, monkeypatch):
    """Same fixture as the round-09 grid/tool split-brain test: the snapshot's
    worker count must equal list_operator_workers' count for the same caller,
    not the raw (unscoped) repos.workers.list count."""
    db = tmp_path / "split.db"
    dbmod, cs = _load_modules(monkeypatch, db)

    c = sqlite3.connect(db)
    _user(c, "op-1", "member")
    _user(c, "vendor", "admin")
    _member(c, "local-default", "op-1", "owner")
    _sv(c, "sv-mine", {"title": "My worker"})
    _worker(c, "my-worker", "sv-mine", "op-1", "local-default", "private")
    _sv(c, "sv-csv", {"title": "CSV Enricher", "is_example": True})
    _worker(c, "csv_enricher", "sv-csv", "vendor", "seed-ws", "public")
    _sv(c, "sv-wa", {"title": "Worker Author", "system_worker": True})
    _worker(c, "worker-author", "sv-wa", "vendor", "seed-ws", "public")
    c.commit()
    c.close()

    from services.worker_access import list_operator_workers
    from services.chat_worker_tools import _agent_worker_visibility_role

    visibility_user_id = cs._effective_worker_visibility_user_id("op-1")
    canonical_workers, _hidden = list_operator_workers(
        user_id=visibility_user_id,
        repos=dbmod.get_repositories(),
        role=_agent_worker_visibility_role(visibility_user_id),
    )

    snapshot = cs._build_capabilities_snapshot("op-1")
    assert _worker_count(snapshot) == len(canonical_workers), (
        f"snapshot worker count != list_operator_workers count: "
        f"{_worker_count(snapshot)} vs {len(canonical_workers)}\n{snapshot}"
    )
    assert len(canonical_workers) == 1
    assert "csv enricher" not in snapshot.lower()
    assert "worker author" not in snapshot.lower()


def test_archived_worker_excluded_from_snapshot(tmp_path, monkeypatch):
    """The old raw repos.workers.list(user_id=...) call never filtered
    archived workers; list_operator_workers does (matching the grid's
    default view, include_archived=False). An archived worker (manifest
    "archived": true, see db/sqlite.py's _worker_record_from_row) must not
    appear in Emily's count."""
    db = tmp_path / "archived.db"
    dbmod, cs = _load_modules(monkeypatch, db)

    c = sqlite3.connect(db)
    _user(c, "op-1", "member")
    _member(c, "local-default", "op-1", "owner")
    _sv(c, "sv-mine", {"title": "My worker"})
    _worker(c, "my-worker", "sv-mine", "op-1", "local-default", "private")
    _sv(c, "sv-old", {"title": "Old worker", "archived": True})
    _worker(c, "old-worker", "sv-old", "op-1", "local-default", "private")
    c.commit()
    c.close()

    snapshot = cs._build_capabilities_snapshot("op-1")
    assert _worker_count(snapshot) == 1, f"expected 1, got snapshot:\n{snapshot}"
    assert "old worker" not in snapshot.lower()
