from __future__ import annotations

import os
import shutil
import shlex
import sqlite3
import subprocess
import sys
from collections import namedtuple
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
API_DIR = ROOT / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _bash_path(path: Path) -> str:
    text = path.as_posix()
    if os.name == "nt" and len(text) >= 3 and text[1:3] == ":/":
        return f"/mnt/{text[0].lower()}{text[2:]}"
    return text


def _require_usable_bash() -> None:
    try:
        result = subprocess.run(["bash", "-lc", "true"], capture_output=True, text=True)
    except FileNotFoundError:
        pytest.skip("bash is not available")
    if result.returncode != 0:
        pytest.skip("bash is not usable in this environment")


def test_prerun_disk_guard_blocks_when_free_space_below_threshold(monkeypatch):
    import run_service

    usage = namedtuple("usage", "total used free")
    monkeypatch.setenv("WORKEROS_MIN_FREE_DISK_BYTES", "1024")
    monkeypatch.setattr(run_service.shutil, "disk_usage", lambda _path: usage(4096, 3584, 512))

    with pytest.raises(run_service.InsufficientDiskSpaceError) as exc:
        run_service._ensure_prerun_disk_space()

    assert "minimum 1024" in str(exc.value)


def test_artifacts_archived_repair_migration_adds_missing_column():
    from db import _legacy_sqlite

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE runs (id TEXT PRIMARY KEY)")
    _legacy_sqlite._ensure_runs_artifacts_archived_column(conn)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(runs)").fetchall()}
    conn.close()

    assert "artifacts_archived" in columns


def test_rotate_artifacts_gzips_old_transcripts(tmp_path):
    db_path = tmp_path / "floom.db"
    artifacts_dir = tmp_path / "artifacts"
    run_dir = artifacts_dir / "run_old"
    run_dir.mkdir(parents=True)
    transcript = run_dir / "transcript.jsonl"
    transcript.write_text('{"type":"tool_call"}\n', encoding="utf-8")
    old_completed_at = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()

    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE runs (
            id TEXT PRIMARY KEY,
            worker_id TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            artifacts_archived INTEGER DEFAULT 0 NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE artifacts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            name TEXT,
            path TEXT,
            size_bytes INTEGER,
            created_at TEXT
        )
        """
    )
    conn.execute(
        "INSERT INTO runs (id, worker_id, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?)",
        ("run_old", "worker", "completed", old_completed_at, old_completed_at),
    )
    conn.execute(
        "INSERT INTO artifacts (id, run_id, name, path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ("art_1", "run_old", "transcript.jsonl", str(transcript), transcript.stat().st_size, old_completed_at),
    )
    conn.commit()
    conn.close()

    env = {
        **os.environ,
        "WORKEROS_ROOT": str(ROOT),
        "FLOOM_DB": str(db_path),
        "FLOOM_ARTIFACTS_DIR": str(artifacts_dir),
        "WORKEROS_ARTIFACT_RETENTION_DAYS": "30",
    }
    result = subprocess.run(
        [sys.executable, str(ROOT / "ops" / "rotate-artifacts.py")],
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )

    gz_path = run_dir / "transcript.jsonl.gz"
    assert "archived_runs=1" in result.stdout
    assert gz_path.is_file()
    assert not transcript.exists()
    conn = sqlite3.connect(db_path)
    run_row = conn.execute("SELECT artifacts_archived FROM runs WHERE id='run_old'").fetchone()
    artifact_row = conn.execute("SELECT name, path, size_bytes FROM artifacts WHERE id='art_1'").fetchone()
    conn.close()
    assert run_row[0] == 1
    assert artifact_row[0] == "transcript.jsonl"
    assert artifact_row[1] == str(gz_path)
    assert artifact_row[2] == gz_path.stat().st_size


def test_backup_script_writes_db_artifacts_and_manifest(tmp_path):
    _require_usable_bash()
    workeros_root = tmp_path / "workeros"
    api_dir = workeros_root / "apps" / "api"
    data_dir = workeros_root / "data"
    ops_dir = workeros_root / "ops"
    api_dir.mkdir(parents=True)
    data_dir.mkdir()
    ops_dir.mkdir()
    shutil.copy2(ROOT / "ops" / "rotate-artifacts.py", ops_dir / "rotate-artifacts.py")
    script_copy = ops_dir / "backup-db.sh"
    script_copy.write_text(
        (ROOT / "ops" / "backup-db.sh").read_text(encoding="utf-8").replace("\r\n", "\n"),
        encoding="utf-8",
        newline="\n",
    )
    db_path = data_dir / "floom.db"
    artifacts_dir = data_dir / "artifacts"
    backup_root = tmp_path / "backups"
    artifacts_dir.mkdir()
    (artifacts_dir / ".gitkeep").write_text("", encoding="utf-8")
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE runs (
            id TEXT PRIMARY KEY,
            created_at TEXT,
            completed_at TEXT,
            artifacts_archived INTEGER DEFAULT 0 NOT NULL
        )
        """
    )
    conn.execute("CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT, name TEXT, path TEXT, size_bytes INTEGER)")
    conn.commit()
    conn.close()

    env = {
        "WORKEROS_ROOT": _bash_path(workeros_root),
        "WORKEROS_API_DIR": _bash_path(api_dir),
        "FLOOM_DB": "../../data/floom.db",
        "FLOOM_ARTIFACTS_DIR": "../../data/artifacts",
        "WORKEROS_BACKUP_ROOT": _bash_path(backup_root),
        "WORKEROS_BACKUP_HOURLY": "48",
        "WORKEROS_BACKUP_DAILY": "7",
        "WORKEROS_BACKUP_WEEKLY": "4",
    }
    bash_env = " ".join(
        f"{key}={shlex.quote(value)}"
        for key, value in env.items()
        if key.startswith(("WORKEROS_", "FLOOM_"))
    )
    result = subprocess.run(
        ["bash", "-lc", f"{bash_env} bash {shlex.quote(_bash_path(script_copy))}"],
        text=True,
        capture_output=True,
        check=True,
    )

    backups = sorted(backup_root.glob("floom-*"))
    assert len(backups) == 1
    backup = backups[0]
    assert (backup / "floom.db.gz").is_file()
    assert (backup / "artifacts.tar.gz").is_file()
    assert (backup / "manifest.json").is_file()
    assert f"wrote {_bash_path(backup)}" in result.stdout
