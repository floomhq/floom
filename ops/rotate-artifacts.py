#!/usr/bin/env python3
"""Compress old internal transcripts and mark artifact archival state."""

from __future__ import annotations

import gzip
import os
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path


def _configured_root() -> Path:
    configured = os.environ.get("WORKEROS_ROOT")
    if configured:
        return Path(configured).resolve()
    if Path("/opt/floom").exists() or not Path("/opt/workeros").exists():
        return Path("/opt/floom").resolve()
    return Path("/opt/workeros").resolve()


def _configured_db(root: Path) -> Path:
    return Path(os.environ.get("FLOOM_DB", str(root / "data" / "floom.db"))).resolve()


def _configured_artifacts(root: Path) -> Path:
    return Path(os.environ.get("FLOOM_ARTIFACTS_DIR", str(root / "data" / "artifacts"))).resolve()


def _retention_days() -> int:
    raw = os.environ.get("WORKEROS_ARTIFACT_RETENTION_DAYS", "30")
    return max(1, int(raw))


def _ensure_runs_archive_column(conn: sqlite3.Connection) -> None:
    columns = {row[1] for row in conn.execute("PRAGMA table_info(runs)").fetchall()}
    if "artifacts_archived" not in columns:
        conn.execute("ALTER TABLE runs ADD COLUMN artifacts_archived INTEGER DEFAULT 0 NOT NULL")


def _safe_artifact_path(artifacts_dir: Path, run_id: str, raw_path: str) -> Path | None:
    path = Path(raw_path)
    if not path.is_absolute():
        path = artifacts_dir / run_id / raw_path
    try:
        resolved = path.resolve()
        resolved.relative_to(artifacts_dir)
    except (OSError, ValueError):
        return None
    return resolved


def _gzip_file(path: Path) -> Path | None:
    if not path.is_file():
        return None
    if path.suffix == ".gz":
        return path
    gz_path = path.with_name(f"{path.name}.gz")
    with path.open("rb") as source, gzip.open(gz_path, "wb", compresslevel=6) as dest:
        shutil.copyfileobj(source, dest)
    path.unlink()
    return gz_path


def main() -> int:
    root = _configured_root()
    db_path = _configured_db(root)
    artifacts_dir = _configured_artifacts(root)
    cutoff = datetime.now(timezone.utc) - timedelta(days=_retention_days())
    if not db_path.is_file():
        print(f"[rotate-artifacts] database not found: {db_path}")
        return 1

    archived_runs = 0
    compressed_transcripts = 0
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        _ensure_runs_archive_column(conn)
        runs = conn.execute(
            """
            SELECT id
            FROM runs
            WHERE COALESCE(completed_at, created_at) < ?
              AND COALESCE(artifacts_archived, 0) = 0
            ORDER BY COALESCE(completed_at, created_at)
            """,
            (cutoff.isoformat(),),
        ).fetchall()

        for run in runs:
            run_id = run["id"]
            transcript_rows = conn.execute(
                """
                SELECT id, name, path
                FROM artifacts
                WHERE run_id = ?
                  AND (
                    LOWER(COALESCE(name, '')) = 'transcript.jsonl'
                    OR LOWER(COALESCE(path, '')) LIKE '%/transcript.jsonl'
                  )
                """,
                (run_id,),
            ).fetchall()
            for artifact in transcript_rows:
                path = _safe_artifact_path(artifacts_dir, run_id, artifact["path"] or "")
                if path is None:
                    continue
                gz_path = _gzip_file(path)
                if gz_path is None:
                    continue
                compressed_transcripts += 1
                conn.execute(
                    """
                    UPDATE artifacts
                    SET path = ?, size_bytes = ?
                    WHERE id = ?
                    """,
                    (str(gz_path), gz_path.stat().st_size, artifact["id"]),
                )
            conn.execute("UPDATE runs SET artifacts_archived = 1 WHERE id = ?", (run_id,))
            archived_runs += 1
        conn.commit()
    finally:
        conn.close()

    print(
        "[rotate-artifacts] "
        f"archived_runs={archived_runs} "
        f"compressed_transcripts={compressed_transcripts} "
        f"cutoff={cutoff.isoformat()}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
